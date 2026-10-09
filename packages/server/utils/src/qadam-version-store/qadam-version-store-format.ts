import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { z } from 'zod'
import { QADAM_VERSION_STORE_LAYOUT, QadamVersionCoordinates } from './qadam-version-store-layout'
import { qadamVersionStoreTree, QadamVersionTree } from './qadam-version-store-tree'

// The two artifact formats a stored version can have (ADR-0003 "the loader reads both formats"):
//
// - BUNDLE: the artifact `tools/scripts/qadams/bundle/qadam-artifact.mjs` builds (#804). Its
//   `package.json` carries `qadamArtifact: { formatVersion: 1, kind }`; `@aiqadam/*` and `zod` are
//   `peerDependencies` the platform provides.
// - LEGACY_NPM: a version published to npm before its qadam moved to the bundle format — today every
//   official `0.x` version, and `qadam-assemblyai@2.0.0` — or a custom qadam. It is the npm package
//   as published plus its installed third-party `node_modules`, with `@aiqadam/*` and `zod`
//   overridden to the platform's copy (#772 option C): they are not installed inside the version,
//   so the qadam's own `require` resolves them upward, to what the platform provides.
//
// The marker decides the format, not the version number: `assemblyai@2.0.0` is past `1.0.0` and
// still legacy. A marker this reader does not know (another `formatVersion`) is refused rather than
// read as legacy, so a newer format is never loaded by rules written for an older one.
//
// Every refusal says whether the version is damaged or only unsupported here: a format, kind or
// provided package a later release knows, or native modules built for another host. A store
// replaces a damaged version but must never replace an unsupported one — another release, or
// another host sharing the volume, may read it fine.
export enum QadamArtifactFormat {
    BUNDLE = 'bundle',
    LEGACY_NPM = 'legacy-npm',
}

export enum QadamArtifactKind {
    BUNDLE = 'bundle',
    BUNDLE_WITH_NODE_MODULES = 'bundle-with-node-modules',
}

export const PLATFORM_PROVIDED_PACKAGES: readonly string[] = ['@aiqadam/shared', '@aiqadam/qadams-framework', '@aiqadam/qadams-common', 'zod']

export const qadamVersionStoreFormat = {
    inspect: async ({ dir, coordinates, tree }: InspectParams): Promise<InspectResult> => {
        const packageJson = await readJsonFile({ filePath: path.join(dir, QADAM_VERSION_STORE_LAYOUT.packageJsonFile), tree, schema: ArtifactPackageJson, maxBytes: MAX_PACKAGE_JSON_BYTES })
        if (!packageJson.ok) {
            return damaged(`package.json: ${packageJson.reason}`)
        }
        if (packageJson.value.name !== coordinates.name || packageJson.value.version !== coordinates.version) {
            return damaged('package.json names another qadam or version')
        }
        const metadata = await readJsonFile({ filePath: path.join(dir, QADAM_VERSION_STORE_LAYOUT.metadataFile), tree, schema: ArtifactMetadata, maxBytes: MAX_METADATA_JSON_BYTES })
        if (!metadata.ok) {
            return damaged(`metadata.json: ${metadata.reason}`)
        }
        if (metadata.value.name !== coordinates.name || metadata.value.version !== coordinates.version) {
            return damaged('metadata.json names another qadam or version')
        }
        const entryPoint = resolveEntryPoint({ main: packageJson.value.main, tree })
        if (isNil(entryPoint)) {
            return damaged('the entry point named by package.json is not a file inside the version')
        }
        const ownCopy = findOwnPlatformPackageCopy({ tree })
        if (!isNil(ownCopy)) {
            return damaged(`the version carries its own copy of ${ownCopy}, which the platform provides`)
        }
        const format = describeFormat({ packageJson: packageJson.value, tree })
        if (!format.ok) {
            return format
        }
        return { ok: true, format: format.format, kind: format.kind, entryPoint }
    },

    // What a reader checks on every lookup, without walking the tree: the marker still says what the
    // integrity record says, and a version with native modules runs only where it was built.
    // The host rule is the one `inspect` applies when the version is written (`describeHostMismatch`).
    checkRuntime: ({ packageJson, format, kind }: CheckRuntimeParams): FormatProblem | null => {
        const marker = ArtifactPackageJson.safeParse(packageJson)
        if (!marker.success) {
            return damaged('package.json is not a qadam package manifest')
        }
        const artifact = marker.data.qadamArtifact
        if (!isNil(artifact) && artifact.formatVersion !== SUPPORTED_ARTIFACT_FORMAT_VERSION) {
            return unsupported(`artifact format version ${artifact.formatVersion} is not one this platform reads`)
        }
        if (!isNil(artifact) && !Object.values(QadamArtifactKind).some((known) => known === artifact.kind)) {
            return unsupported(`artifact kind ${artifact.kind} is not one this platform reads`)
        }
        const markerFormat = isNil(artifact) ? QadamArtifactFormat.LEGACY_NPM : QadamArtifactFormat.BUNDLE
        if (markerFormat !== format || (marker.data.qadamArtifact?.kind ?? null) !== kind) {
            return damaged('package.json disagrees with the integrity record')
        }
        const mismatch = describeHostMismatch({ kind, builtFor: marker.data.qadamArtifact?.builtFor })
        return isNil(mismatch) ? null : unsupported(mismatch)
    },
}

// A version's own `package.json` is small; its `metadata.json` is the largest JSON a qadam has
// (the whole catalogue's current metadata is 5.4 MB, ADR-0003 Evidence).
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const MAX_METADATA_JSON_BYTES = 32 * 1024 * 1024
const SUPPORTED_ARTIFACT_FORMAT_VERSION = 1

const BuiltFor = z.object({
    os: z.string(),
    cpu: z.string(),
    // `glibc <major>.<minor>` or `unknown` (not glibc), as #804's builder records it.
    libc: z.string().optional(),
    node: z.string().optional(),
}).loose()

const ProcessReport = z.object({
    header: z.object({ glibcVersionRuntime: z.string().optional() }).loose(),
}).loose()

const GLIBC_PATTERN = /^glibc (\d+)\.(\d+)/

const ArtifactMarker = z.object({
    formatVersion: z.number(),
    kind: z.string(),
    builtFor: BuiltFor.optional(),
}).loose()

const ArtifactPackageJson = z.object({
    name: z.string(),
    version: z.string(),
    main: z.string().optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    qadamArtifact: ArtifactMarker.optional(),
}).loose()

const ArtifactMetadata = z.object({
    name: z.string(),
    version: z.string(),
    actions: z.record(z.string(), z.unknown()),
    triggers: z.record(z.string(), z.unknown()),
}).loose()

async function readJsonFile<T>({ filePath, tree, schema, maxBytes }: ReadJsonFileParams<T>): Promise<JsonFileResult<T>> {
    const relativePath = path.basename(filePath)
    if (!qadamVersionStoreTree.has({ tree, relativePath, kind: 'file' })) {
        return { ok: false, reason: 'missing, or not a regular file' }
    }
    const stats = await tryCatch(() => stat(filePath))
    if (stats.error !== null) {
        return { ok: false, reason: 'cannot be read' }
    }
    if (stats.data.size > maxBytes) {
        return { ok: false, reason: `larger than ${maxBytes} bytes` }
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(await readFile(filePath, 'utf8')))
    if (parsed.error !== null) {
        return { ok: false, reason: 'not valid JSON' }
    }
    const result = schema.safeParse(parsed.data)
    return result.success ? { ok: true, value: result.data } : { ok: false, reason: 'unexpected shape' }
}

// `main` as Node's CommonJS loader reads it — the file, `<main>.js`, `<main>/index.js`, then the
// package's `index.js` when `main` is absent, empty or resolves to nothing (Node's DEP0128 fallback) —
// limited to `.js` (a qadam's entry is JavaScript, never `.json` or `.node`) and held to the version's
// own directory: no absolute path, no `..`, and the file must be a regular file of the version (a
// symlink there could point anywhere the version can).
function resolveEntryPoint({ main, tree }: { main: string | undefined, tree: QadamVersionTree }): string | null {
    const declared = isNil(main) || main === '' ? null : path.posix.normalize(main).replace(/^\.\//, '').replace(/\/$/, '')
    if (!isNil(declared) && (path.posix.isAbsolute(declared) || declared.split('/').includes('..') || declared.includes('\\'))) {
        return null
    }
    const fromMain = isNil(declared) || declared === '' || declared === '.' ? [] : [declared, `${declared}.js`, `${declared}/index.js`]
    return [...fromMain, 'index.js'].find((candidate) => qadamVersionStoreTree.has({ tree, relativePath: candidate, kind: 'file' })) ?? null
}

// The version's own `require('@aiqadam/qadams-framework')` or `require('zod')` would find a copy
// at `node_modules/<name>` before the platform's, which is the duplication ADR-0003 removes. A
// third-party dependency may keep a private `zod` nested under its own `node_modules`; no
// third-party package carries an `@aiqadam` one.
function findOwnPlatformPackageCopy({ tree }: { tree: QadamVersionTree }): string | null {
    const copies = tree.entries.map((entry) => entry.path.split('/')).flatMap((segments) => {
        const scopeIndex = segments.findIndex((segment, index) => segment === '@aiqadam' && segments[index - 1] === 'node_modules')
        if (scopeIndex !== -1) {
            return [isNil(segments[scopeIndex + 1]) ? '@aiqadam' : `@aiqadam/${segments[scopeIndex + 1]}`]
        }
        return segments[0] === 'node_modules' && segments[1] === 'zod' ? ['zod'] : []
    })
    return copies.find((copy) => copy !== '@aiqadam') ?? copies[0] ?? null
}

function describeFormat({ packageJson, tree }: DescribeFormatParams): FormatResult {
    const marker = packageJson.qadamArtifact
    if (isNil(marker)) {
        return { ok: true, format: QadamArtifactFormat.LEGACY_NPM, kind: null }
    }
    if (marker.formatVersion !== SUPPORTED_ARTIFACT_FORMAT_VERSION) {
        return unsupported(`artifact format version ${marker.formatVersion} is not one this platform reads`)
    }
    const kind = Object.values(QadamArtifactKind).find((known) => known === marker.kind)
    if (isNil(kind)) {
        return unsupported(`artifact kind ${marker.kind} is not one this platform reads`)
    }
    const unknownPeers = Object.keys(packageJson.peerDependencies ?? {}).filter((peer) => !PLATFORM_PROVIDED_PACKAGES.includes(peer))
    if (unknownPeers.length > 0) {
        return unsupported(`the bundle expects packages the platform does not provide: ${unknownPeers.join(', ')}`)
    }
    const hasNodeModules = qadamVersionStoreTree.has({ tree, relativePath: 'node_modules', kind: 'directory' })
    if (kind === QadamArtifactKind.BUNDLE && hasNodeModules) {
        return damaged('a plain bundle carries node_modules')
    }
    const mismatch = describeHostMismatch({ kind, builtFor: marker.builtFor })
    if (!isNil(mismatch)) {
        return unsupported(mismatch)
    }
    return { ok: true, format: QadamArtifactFormat.BUNDLE, kind }
}

// A version with native modules runs only where they were built: the OS and CPU, the C library
// (glibc at least as new as the one it was built against, or not glibc on both sides), and the
// Node major, whose module ABI a prebuilt addon is compiled for. #804 records all four as `builtFor`.
// The same rule applies when a version is written and when it is read. Versions without native
// modules carry no `builtFor` and run anywhere.
function describeHostMismatch({ kind, builtFor }: { kind: QadamArtifactKind | null, builtFor: z.infer<typeof BuiltFor> | undefined }): string | null {
    if (kind !== QadamArtifactKind.BUNDLE_WITH_NODE_MODULES) {
        return null
    }
    if (isNil(builtFor) || isNil(builtFor.libc) || isNil(builtFor.node)) {
        return 'native modules without a record of the os, cpu, libc and node they were built for'
    }
    const host = hostPlatform()
    const built = `built for ${builtFor.os}-${builtFor.cpu} ${builtFor.libc} node ${builtFor.node}`
    const here = `this host is ${host.os}-${host.cpu} ${host.libc} node ${host.node}`
    if (builtFor.os !== host.os || builtFor.cpu !== host.cpu || majorOf({ version: builtFor.node }) !== majorOf({ version: host.node })) {
        return `${built}, ${here}`
    }
    return isLibcCompatible({ built: builtFor.libc, host: host.libc }) ? null : `${built}, ${here}`
}

function isLibcCompatible({ built, host }: { built: string, host: string }): boolean {
    const builtGlibc = GLIBC_PATTERN.exec(built)
    const hostGlibc = GLIBC_PATTERN.exec(host)
    if (isNil(builtGlibc) || isNil(hostGlibc)) {
        return isNil(builtGlibc) && isNil(hostGlibc) && built === host
    }
    const [builtMajor, builtMinor] = [Number(builtGlibc[1]), Number(builtGlibc[2])]
    const [hostMajor, hostMinor] = [Number(hostGlibc[1]), Number(hostGlibc[2])]
    return hostMajor > builtMajor || (hostMajor === builtMajor && hostMinor >= builtMinor)
}

function majorOf({ version }: { version: string }): string {
    return version.split('.')[0] ?? ''
}

// Computed once: `process.report.getReport()` is not free, and the host does not change.
let cachedHost: HostPlatform | null = null

function hostPlatform(): HostPlatform {
    if (isNil(cachedHost)) {
        const report = ProcessReport.safeParse(process.report?.getReport())
        const glibc = report.success ? report.data.header.glibcVersionRuntime : undefined
        cachedHost = { os: process.platform, cpu: process.arch, libc: isNil(glibc) ? 'unknown' : `glibc ${glibc}`, node: process.versions.node }
    }
    return cachedHost
}

function damaged(reason: string): FormatProblem {
    return { ok: false, reason, unsupported: false }
}

function unsupported(reason: string): FormatProblem {
    return { ok: false, reason, unsupported: true }
}

type InspectParams = {
    dir: string
    coordinates: QadamVersionCoordinates
    tree: QadamVersionTree
}

// `unsupported`: not damaged, only not runnable by this release on this host (see the header).
export type FormatProblem = { ok: false, reason: string, unsupported: boolean }

type InspectResult =
    | { ok: true, format: QadamArtifactFormat, kind: QadamArtifactKind | null, entryPoint: string }
    | FormatProblem

type FormatResult =
    | { ok: true, format: QadamArtifactFormat, kind: QadamArtifactKind | null }
    | FormatProblem

type HostPlatform = {
    os: string
    cpu: string
    libc: string
    node: string
}

type DescribeFormatParams = {
    packageJson: z.infer<typeof ArtifactPackageJson>
    tree: QadamVersionTree
}

type CheckRuntimeParams = {
    packageJson: unknown
    format: QadamArtifactFormat
    kind: QadamArtifactKind | null
}

type ReadJsonFileParams<T> = {
    filePath: string
    tree: QadamVersionTree
    schema: z.ZodType<T>
    maxBytes: number
}

type JsonFileResult<T> = { ok: true, value: T } | { ok: false, reason: string }
