import { realpathSync } from 'node:fs'
import { createRequire, isBuiltin, registerHooks, ResolveFnOutput, ResolveHookContext } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLATFORM_PROVIDED_PACKAGES, QADAM_VERSION_STORE_LAYOUT, qadamVersionStoreLayout } from '@aiqadam/server-utils/qadam-version-store-reader'
import { isNil, tryCatchSync } from '@aiqadam/shared'

// ADR-0003: a stored qadam version carries its own code and third-party dependencies, and the
// platform provides `@aiqadam/*` and `zod` once per engine. A module loaded from the store
// resolves as follows:
//   - a builtin (`fs`, `node:fs`) is Node's;
//   - a package the platform provides (`PLATFORM_PROVIDED_PACKAGES`, and their subpaths) is the
//     platform's copy: the files a bundled qadam reaches through its own `node_modules`, so a stored
//     and a bundled qadam share one copy (Node caches a module by its real path). The qadam's own
//     code always gets that copy, whatever it ships beside itself. A third-party dependency inside
//     the version's `node_modules` may keep a private copy nested under it (a legacy npm install
//     can carry one, #829), so for it a copy found inside the version comes first;
//   - anything else must resolve inside the module's own version directory. Node would go on to
//     `NODE_PATH` (the sandbox env sets `/usr/src/node_modules`), `$HOME/.node_modules`,
//     `$HOME/.node_libraries` and `$PREFIX/lib/node`, and a version would silently run on whatever
//     it found there. It fails as "module not found" instead.
//
// This is a correctness guard against accidental lookups, not a sandbox: a stored version runs in
// the engine's process with the engine's rights, and nothing here stops code that means to reach
// another file (an absolute `require`, `fs`). Isolation is the execution mode's job.
//
// The store's `qadams/node_modules` (reserved by its layout) is not used: the volume is shared by
// every replica and outlives the image, so a copy or a link there could name another image's
// libraries. The platform's copy is this process's.
export const qadamPlatformModules = {
    // Starts guarding the modules loaded from the store at `storeRoot` (a real path). The hook is
    // registered once per process and serves every store root guarded through it.
    guard: ({ storeRoot }: { storeRoot: string }): GuardResult => {
        // Each package resolved the way a stored version will ask for it. The reason names the
        // package, never a path.
        const missing = PLATFORM_PROVIDED_PACKAGES.find((packageName) => tryCatchSync(() => resolveFromPlatform({ specifier: packageName })).error !== null)
        if (!isNil(missing)) {
            return { ok: false, reason: `the platform's copy of ${missing} cannot be found` }
        }
        if (!hooksRegistered) {
            const { error } = tryCatchSync(() => registerHooks({ resolve: resolveForStoredModules }))
            if (error !== null) {
                return { ok: false, reason: 'module resolution hooks cannot be registered' }
            }
            hooksRegistered = true
        }
        guardedQadamsDirs.add(path.join(storeRoot, QADAM_VERSION_STORE_LAYOUT.qadamsDir))
        return { ok: true }
    },

    // The file a stored version gets for a package the platform provides. Throws for anything that is
    // not one, or that leaves the package.
    resolve: ({ specifier }: { specifier: string }): string => resolveFromPlatform({ specifier }),
}

let hooksRegistered = false
let platformPackageDirs: Map<string, string> | null = null
const guardedQadamsDirs = new Set<string>()

function resolveForStoredModules(specifier: string, context: ResolveHookContext, nextResolve: NextResolve): ResolveFnOutput {
    const parent = storedParentOf({ parentURL: context.parentURL })
    if (parent.kind === 'outside-store') {
        return nextResolve(specifier, context)
    }
    if (parent.kind === 'outside-version') {
        throw notProvided({ specifier })
    }
    if (isBuiltin(specifier)) {
        return nextResolve(specifier, context)
    }
    if (isPlatformProvided({ specifier })) {
        if (parent.isThirdParty) {
            const own = tryCatchSync(() => nextResolve(specifier, context))
            if (own.error === null && isInsideVersion({ url: own.data.url, versionDir: parent.versionDir })) {
                return own.data
            }
        }
        return { url: pathToFileURL(resolveFromPlatform({ specifier })).href, shortCircuit: true }
    }
    const own = nextResolve(specifier, context)
    if (isInsideVersion({ url: own.url, versionDir: parent.versionDir })) {
        return own
    }
    throw notProvided({ specifier })
}

function storedParentOf({ parentURL }: { parentURL: string | undefined }): StoredParent {
    if (isNil(parentURL) || !parentURL.startsWith('file:')) {
        return { kind: 'outside-store' }
    }
    const parentPath = fileURLToPath(parentURL)
    for (const qadamsDir of guardedQadamsDirs) {
        const relative = path.relative(qadamsDir, parentPath)
        if (relative === '' || qadamVersionStoreLayout.isOutside({ relative })) {
            continue
        }
        const segments = relative.split(path.sep)
        const versionDepth = versionDepthOf({ segments })
        if (isNil(versionDepth)) {
            return { kind: 'outside-version' }
        }
        return {
            kind: 'version',
            versionDir: path.join(qadamsDir, ...segments.slice(0, versionDepth)),
            isThirdParty: segments[versionDepth] === NODE_MODULES,
        }
    }
    return { kind: 'outside-store' }
}

// How many segments `<name>/<version>` or `_platform/<platformId>/<name>/<version>` take, where a
// scoped name is two. Anything else in the store (its reserved `node_modules`, a dot directory) is
// not a version, and nothing loaded from there may resolve anything.
function versionDepthOf({ segments }: { segments: string[] }): number | null {
    const nameStart = segments[0] === QADAM_VERSION_STORE_LAYOUT.platformNamespaceDir ? 2 : 0
    const firstNameSegment = segments[nameStart]
    if (isNil(firstNameSegment) || qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName: firstNameSegment })) {
        return null
    }
    const versionDepth = nameStart + (firstNameSegment.startsWith('@') ? 2 : 1) + 1
    // The version directory and a file inside it.
    return segments.length > versionDepth ? versionDepth : null
}

// Not a file (a builtin's `node:` URL) leaves nothing to check.
function isInsideVersion({ url, versionDir }: { url: string, versionDir: string }): boolean {
    if (!url.startsWith('file:')) {
        return true
    }
    return isInside({ dir: versionDir, file: fileURLToPath(url) })
}

function isPlatformProvided({ specifier }: { specifier: string }): boolean {
    return !isNil(providedPackageOf({ specifier }))
}

function providedPackageOf({ specifier }: { specifier: string }): string | undefined {
    return PLATFORM_PROVIDED_PACKAGES.find((packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`))
}

// The resolved file must lie inside that package's own directory: `@aiqadam/shared/../../x` names
// a provided package and would otherwise resolve, through the platform's anchor, to any file.
function resolveFromPlatform({ specifier }: { specifier: string }): string {
    const packageName = providedPackageOf({ specifier })
    const subpath = isNil(packageName) ? '' : specifier.slice(packageName.length)
    if (isNil(packageName) || subpath.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw notProvided({ specifier })
    }
    const packageDir = getPlatformPackageDirs().get(packageName)
    if (isNil(packageDir)) {
        throw notProvided({ specifier })
    }
    const resolved = WORKSPACE_PACKAGES.has(packageName)
        // A workspace package has no `exports`, so its subpaths are paths inside it.
        ? createRequire(path.join(packageDir, 'package.json')).resolve(`.${subpath}`)
        : frameworkRequire().resolve(specifier)
    if (!isInside({ dir: packageDir, file: resolved })) {
        throw notProvided({ specifier })
    }
    return resolved
}

// The real directory of each package the platform provides. `qadams-framework` and `qadams-common`
// are workspace packages; `@aiqadam/shared` and `zod` are the framework's own runtime dependencies,
// the copies it validates and re-exports with. Relative to the working directory, like the bundled
// qadams root (`qadam-dist-index.ts`).
function getPlatformPackageDirs(): Map<string, string> {
    if (!isNil(platformPackageDirs)) {
        return platformPackageDirs
    }
    const located = new Map<string, string>([
        [FRAMEWORK_PACKAGE, realpathSync(path.resolve(FRAMEWORK_DIR))],
        [COMMON_PACKAGE, realpathSync(path.resolve(COMMON_DIR))],
        ...FRAMEWORK_DEPENDENCIES.map((packageName): [string, string] => [packageName, path.dirname(frameworkRequire().resolve(`${packageName}/package.json`))]),
    ])
    const missing = PLATFORM_PROVIDED_PACKAGES.find((packageName) => !located.has(packageName))
    if (!isNil(missing)) {
        throw new Error(`no platform copy is configured for ${missing}`)
    }
    platformPackageDirs = located
    return located
}

function frameworkRequire(): NodeJS.Require {
    return createRequire(path.resolve(FRAMEWORK_DIR, 'package.json'))
}

function isInside({ dir, file }: { dir: string, file: string }): boolean {
    const relative = path.relative(dir, file)
    return relative !== '' && !qadamVersionStoreLayout.isOutside({ relative })
}

function notProvided({ specifier }: { specifier: string }): Error {
    return Object.assign(
        new Error(`Cannot find module '${specifier}': a stored qadam version resolves only its own files and dependencies, and the packages the platform provides (${PLATFORM_PROVIDED_PACKAGES.join(', ')})`),
        { code: 'MODULE_NOT_FOUND' },
    )
}

const NODE_MODULES = 'node_modules'
const FRAMEWORK_PACKAGE = '@aiqadam/qadams-framework'
const COMMON_PACKAGE = '@aiqadam/qadams-common'
const FRAMEWORK_DIR = 'packages/qadams/framework'
const COMMON_DIR = 'packages/qadams/common'
const WORKSPACE_PACKAGES = new Set([FRAMEWORK_PACKAGE, COMMON_PACKAGE])
const FRAMEWORK_DEPENDENCIES = ['@aiqadam/shared', 'zod']

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput

type StoredParent =
    | { kind: 'outside-store' }
    | { kind: 'outside-version' }
    | { kind: 'version', versionDir: string, isThirdParty: boolean }

type GuardResult = { ok: true } | { ok: false, reason: string }
