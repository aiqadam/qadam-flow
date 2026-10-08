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
            return { ok: false, reason: `package.json: ${packageJson.reason}` }
        }
        if (packageJson.value.name !== coordinates.name || packageJson.value.version !== coordinates.version) {
            return { ok: false, reason: 'package.json names another qadam or version' }
        }
        const metadata = await readJsonFile({ filePath: path.join(dir, QADAM_VERSION_STORE_LAYOUT.metadataFile), tree, schema: ArtifactMetadata, maxBytes: MAX_METADATA_JSON_BYTES })
        if (!metadata.ok) {
            return { ok: false, reason: `metadata.json: ${metadata.reason}` }
        }
        if (metadata.value.name !== coordinates.name || metadata.value.version !== coordinates.version) {
            return { ok: false, reason: 'metadata.json names another qadam or version' }
        }
        const entryPoint = resolveEntryPoint({ main: packageJson.value.main, tree })
        if (isNil(entryPoint)) {
            return { ok: false, reason: 'the entry point named by package.json is not a file inside the version' }
        }
        const ownCopy = findOwnPlatformPackageCopy({ tree })
        if (!isNil(ownCopy)) {
            return { ok: false, reason: `the version carries its own copy of ${ownCopy}, which the platform provides` }
        }
        const format = describeFormat({ packageJson: packageJson.value, tree })
        if (!format.ok) {
            return format
        }
        return { ok: true, format: format.format, kind: format.kind, entryPoint }
    },

    // What a reader checks on every lookup, without walking the tree: the marker still says what the
    // integrity record says, and a version with native modules runs only where it was built.
    checkRuntime: ({ packageJson, format, kind }: CheckRuntimeParams): string | null => {
        const marker = ArtifactPackageJson.safeParse(packageJson)
        if (!marker.success) {
            return 'package.json is not a qadam package manifest'
        }
        const markerFormat = isNil(marker.data.qadamArtifact) ? QadamArtifactFormat.LEGACY_NPM : QadamArtifactFormat.BUNDLE
        if (markerFormat !== format || (marker.data.qadamArtifact?.kind ?? null) !== kind) {
            return 'package.json disagrees with the integrity record'
        }
        return describeHostMismatch({ builtFor: marker.data.qadamArtifact?.builtFor })
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
}).loose()

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
    const size = (await stat(filePath)).size
    if (size > maxBytes) {
        return { ok: false, reason: `larger than ${maxBytes} bytes` }
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(await readFile(filePath, 'utf8')))
    if (parsed.error !== null) {
        return { ok: false, reason: 'not valid JSON' }
    }
    const result = schema.safeParse(parsed.data)
    return result.success ? { ok: true, value: result.data } : { ok: false, reason: 'unexpected shape' }
}

// `main` as Node reads it, held to the version's own directory: no absolute path, no `..`, and the
// file must be a regular file of the version (a symlink there could point anywhere the version can).
function resolveEntryPoint({ main, tree }: { main: string | undefined, tree: QadamVersionTree }): string | null {
    const declared = path.posix.normalize(main ?? 'index.js').replace(/^\.\//, '')
    if (declared === '' || declared === '.' || path.posix.isAbsolute(declared) || declared.split('/').includes('..') || declared.includes('\\')) {
        return null
    }
    const candidates = [declared, `${declared}.js`, `${declared}/index.js`]
    return candidates.find((candidate) => qadamVersionStoreTree.has({ tree, relativePath: candidate, kind: 'file' })) ?? null
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
        return { ok: false, reason: `artifact format version ${marker.formatVersion} is not one this platform reads` }
    }
    const kind = Object.values(QadamArtifactKind).find((known) => known === marker.kind)
    if (isNil(kind)) {
        return { ok: false, reason: `artifact kind ${marker.kind} is not one this platform reads` }
    }
    const unknownPeers = Object.keys(packageJson.peerDependencies ?? {}).filter((peer) => !PLATFORM_PROVIDED_PACKAGES.includes(peer))
    if (unknownPeers.length > 0) {
        return { ok: false, reason: `the bundle expects packages the platform does not provide: ${unknownPeers.join(', ')}` }
    }
    const hasNodeModules = qadamVersionStoreTree.has({ tree, relativePath: 'node_modules', kind: 'directory' })
    if (kind === QadamArtifactKind.BUNDLE && hasNodeModules) {
        return { ok: false, reason: 'a plain bundle carries node_modules' }
    }
    if (kind === QadamArtifactKind.BUNDLE_WITH_NODE_MODULES) {
        const mismatch = describeHostMismatch({ builtFor: marker.builtFor })
        if (!isNil(mismatch)) {
            return { ok: false, reason: mismatch }
        }
    }
    return { ok: true, format: QadamArtifactFormat.BUNDLE, kind }
}

// A native addon runs only on the OS and CPU it was built for (#804 records them as `builtFor`).
function describeHostMismatch({ builtFor }: { builtFor: z.infer<typeof BuiltFor> | undefined }): string | null {
    if (isNil(builtFor)) {
        return null
    }
    if (builtFor.os !== process.platform || builtFor.cpu !== process.arch) {
        return `built for ${builtFor.os}-${builtFor.cpu}, this host is ${process.platform}-${process.arch}`
    }
    return null
}

type InspectParams = {
    dir: string
    coordinates: QadamVersionCoordinates
    tree: QadamVersionTree
}

type InspectResult =
    | { ok: true, format: QadamArtifactFormat, kind: QadamArtifactKind | null, entryPoint: string }
    | { ok: false, reason: string }

type FormatResult =
    | { ok: true, format: QadamArtifactFormat, kind: QadamArtifactKind | null }
    | { ok: false, reason: string }

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
