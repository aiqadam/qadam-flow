import { createRequire, isBuiltin, registerHooks, ResolveFnOutput, ResolveHookContext } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLATFORM_PROVIDED_PACKAGES, QADAM_VERSION_STORE_LAYOUT, qadamVersionStoreLayout } from '@aiqadam/server-utils/qadam-version-store'
import { isNil, tryCatchSync } from '@aiqadam/shared'

// ADR-0003: a stored qadam version carries its own code and third-party dependencies, and the
// platform provides `@aiqadam/*` and `zod` once per engine. A module loaded from the store
// resolves, in this order:
//   1. what Node finds inside its own version directory (its files, its own `node_modules`);
//   2. for a package the platform provides, the platform's copy: the files a bundled qadam reaches
//      through its own `node_modules`, so a stored and a bundled qadam share one copy (Node caches
//      a module by its real path);
//   3. nothing else. Node would go on to `NODE_PATH` (the sandbox env sets `/usr/src/node_modules`),
//      `$HOME/.node_modules`, `$HOME/.node_libraries` and `$PREFIX/lib/node`, and a version would
//      silently run on whatever it found there. It fails as "module not found" instead.
// Builtins (`fs`, `node:fs`) are always Node's.
//
// The store's `qadams/node_modules` (reserved by its layout) is not used: the volume is shared by
// every replica and outlives the image, so a copy or a link there could name another image's
// libraries. The platform's copy is this process's.
export const qadamPlatformModules = {
    // Starts guarding the modules loaded from the store at `storeRoot` (a real path). The hook is
    // registered once per process and serves every store root guarded through it.
    guard: ({ storeRoot }: { storeRoot: string }): GuardResult => {
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

    // The file a stored version gets for a package the platform provides.
    resolve: ({ specifier }: { specifier: string }): string => resolveFromPlatform({ specifier }),
}

let hooksRegistered = false
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
    const own = tryCatchSync(() => nextResolve(specifier, context))
    if (own.error === null && isInsideVersion({ url: own.data.url, versionDir: parent.versionDir })) {
        return own.data
    }
    if (isPlatformProvided({ specifier })) {
        return { url: pathToFileURL(resolveFromPlatform({ specifier })).href, shortCircuit: true }
    }
    if (own.error !== null) {
        throw own.error
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
        const versionDir = versionDirOf({ qadamsDir, segments: relative.split(path.sep) })
        return isNil(versionDir) ? { kind: 'outside-version' } : { kind: 'version', versionDir }
    }
    return { kind: 'outside-store' }
}

// `<qadams>/<name>/<version>/…` or `<qadams>/_platform/<platformId>/<name>/<version>/…`, where a
// scoped name is two segments. Anything else in the store (its reserved `node_modules`, a dot
// directory) is not a version, and nothing loaded from there may resolve anything.
function versionDirOf({ qadamsDir, segments }: { qadamsDir: string, segments: string[] }): string | null {
    const nameStart = segments[0] === QADAM_VERSION_STORE_LAYOUT.platformNamespaceDir ? 2 : 0
    const firstNameSegment = segments[nameStart]
    if (isNil(firstNameSegment) || qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName: firstNameSegment })) {
        return null
    }
    const versionEnd = nameStart + (firstNameSegment.startsWith('@') ? 2 : 1) + 1
    // The version directory and a file inside it.
    if (segments.length <= versionEnd) {
        return null
    }
    return path.join(qadamsDir, ...segments.slice(0, versionEnd))
}

// Not a file (a builtin's `node:` URL) leaves nothing to check.
function isInsideVersion({ url, versionDir }: { url: string, versionDir: string }): boolean {
    if (!url.startsWith('file:')) {
        return true
    }
    const relative = path.relative(versionDir, fileURLToPath(url))
    return relative !== '' && !qadamVersionStoreLayout.isOutside({ relative })
}

function isPlatformProvided({ specifier }: { specifier: string }): boolean {
    return PLATFORM_PROVIDED_PACKAGES.some((packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`))
}

// Every bundled qadam reaches the four packages through `node_modules` symlinks into the same
// workspace packages, and `qadams-common`'s own `node_modules` holds the other three, so it is the
// one anchor that resolves all of them; `qadams-common` itself is that anchor's own package.
// Relative to the working directory, like the bundled qadams root (`qadam-dist-index.ts`).
function resolveFromPlatform({ specifier }: { specifier: string }): string {
    const anchor = createRequire(path.resolve(PLATFORM_ANCHOR_PACKAGE_JSON))
    if (specifier === COMMON_PACKAGE || specifier.startsWith(`${COMMON_PACKAGE}/`)) {
        return anchor.resolve(`.${specifier.slice(COMMON_PACKAGE.length)}`)
    }
    return anchor.resolve(specifier)
}

function notProvided({ specifier }: { specifier: string }): Error {
    return Object.assign(
        new Error(`Cannot find module '${specifier}': a stored qadam version resolves only its own files and dependencies, and the packages the platform provides (${PLATFORM_PROVIDED_PACKAGES.join(', ')})`),
        { code: 'MODULE_NOT_FOUND' },
    )
}

const COMMON_PACKAGE = '@aiqadam/qadams-common'
const PLATFORM_ANCHOR_PACKAGE_JSON = 'packages/qadams/common/package.json'

type NextResolve = (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput

type StoredParent =
    | { kind: 'outside-store' }
    | { kind: 'outside-version' }
    | { kind: 'version', versionDir: string }

type GuardResult = { ok: true } | { ok: false, reason: string }
