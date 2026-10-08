import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import semver from 'semver'
import { z } from 'zod'
import { fileSystemUtils } from '../file-system-utils'
import { QadamArtifactFormat, QadamArtifactKind, qadamVersionStoreFormat } from './qadam-version-store-format'
import { QADAM_VERSION_STORE_LAYOUT, QadamVersionCoordinates, qadamVersionStoreLayout } from './qadam-version-store-layout'
import { qadamVersionStoreTarball, QadamVersionTarballLimits } from './qadam-version-store-tarball'
import { qadamVersionStoreTree } from './qadam-version-store-tree'

export enum QadamVersionOrigin {
    // Shipped in the image and copied into the store at start-up (#805, #807).
    IMAGE_SEED = 'image-seed',
    // Fetched from npmjs or a configured registry (#806).
    REGISTRY = 'registry',
    // Uploaded by a platform admin as a tarball.
    ARCHIVE = 'archive',
}

export enum QadamVersionReadStatus {
    PRESENT = 'present',
    ABSENT = 'absent',
    // On disk but not usable: damaged, written by a format this platform does not read, built for
    // another host, or asked for by coordinates that can never name a version.
    INVALID = 'invalid',
}

export enum QadamVersionPutStatus {
    STORED = 'stored',
    // That version was already there, or another writer stored it first. A version is never
    // overwritten (ADR-0001: a version is never reused).
    EXISTS = 'exists',
    REFUSED = 'refused',
}

export const DEFAULT_QADAM_VERSION_STORE_LIMITS: QadamVersionTarballLimits = {
    // `bundle-with-node-modules` versions carry a dependency closure: text-helper's is 1,454 files.
    maxEntries: 100_000,
    maxBytes: 2 * 1024 * 1024 * 1024,
    maxFileBytes: 512 * 1024 * 1024,
}

// The versioned qadam store of ADR-0003 on a persistent volume, by `name@version`, per namespace.
//
// It is not authoritative yet: nothing resolves a step through it until #779 switches the API,
// worker and engine over. Until then it is written (seeded from the image) and read by its own
// checks only, and no flow runs differently because it exists.
//
// Writes are atomic: a version is assembled in `<root>/.staging/`, checked, given its
// `integrity.json`, flushed, and renamed into place, so a reader sees a complete version or none.
// Two writers of the same version on a shared volume (replicas, rolling upgrades) both stage; one
// rename wins and the other finds the version present and discards its copy.
export const qadamVersionStore = {
    open: async ({ root, log, limits = DEFAULT_QADAM_VERSION_STORE_LIMITS }: OpenParams): Promise<OpenResult> => {
        const absoluteRoot = path.resolve(root)
        const prepared = await tryCatch(async () => {
            await Promise.all([
                mkdir(path.join(absoluteRoot, QADAM_VERSION_STORE_LAYOUT.qadamsDir), { recursive: true }),
                mkdir(path.join(absoluteRoot, QADAM_VERSION_STORE_LAYOUT.stagingDir), { recursive: true }),
                mkdir(path.join(absoluteRoot, QADAM_VERSION_STORE_LAYOUT.trashDir), { recursive: true }),
            ])
            return realpath(absoluteRoot)
        })
        if (prepared.error !== null) {
            return { ok: false, reason: `the store directory cannot be prepared (${describeErrorCode({ error: prepared.error })})` }
        }
        const realRoot = prepared.data
        const caseSensitive = await tryCatch(() => isCaseSensitive({ dir: path.join(realRoot, QADAM_VERSION_STORE_LAYOUT.stagingDir) }))
        if (caseSensitive.error !== null) {
            return { ok: false, reason: `the store directory is not writable (${describeErrorCode({ error: caseSensitive.error })})` }
        }
        // Platform ids and prerelease versions differ by case alone; on a case-insensitive
        // filesystem two platforms could share a directory, so the store refuses to open there.
        if (!caseSensitive.data) {
            return { ok: false, reason: 'the store directory is on a case-insensitive filesystem' }
        }
        const cleaned = await tryCatch(() => removeLeftovers({ root: realRoot, log }))
        if (cleaned.error !== null) {
            log.warn({ error: describeErrorCode({ error: cleaned.error }) }, '[qadamVersionStore] Could not look for leftover staging or trash directories')
        }
        return { ok: true, store: createStore({ root: realRoot, log, limits }) }
    },
}

function createStore({ root, log, limits }: CreateStoreParams): QadamVersionStore {
    const stagingRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.stagingDir)
    const trashRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.trashDir)

    const read = async ({ coordinates, verify = false }: ReadParams): Promise<QadamVersionReadResult> => {
        const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
        if (!validation.valid) {
            return { status: QadamVersionReadStatus.INVALID, reason: validation.reason }
        }
        const dir = qadamVersionStoreLayout.versionDir({ root, coordinates })
        const dirStats = await tryCatch(() => lstat(dir))
        if (dirStats.error !== null) {
            return fileSystemUtils.hasErrorCode({ error: dirStats.error, code: 'ENOENT' })
                ? { status: QadamVersionReadStatus.ABSENT }
                : { status: QadamVersionReadStatus.INVALID, reason: `cannot be read (${describeErrorCode({ error: dirStats.error })})` }
        }
        if (!dirStats.data.isDirectory()) {
            return { status: QadamVersionReadStatus.INVALID, reason: 'not a directory' }
        }
        // A directory of the path replaced by a symlink would make this version live somewhere
        // else on the host; the real path must be the one the layout names.
        const real = await tryCatch(() => realpath(dir))
        if (real.error !== null || real.data !== dir) {
            return { status: QadamVersionReadStatus.INVALID, reason: 'the version path goes through a symlink' }
        }
        const record = await readIntegrityRecord({ dir })
        if (!record.ok) {
            return { status: QadamVersionReadStatus.INVALID, reason: record.reason }
        }
        const integrity = record.record
        if (integrity.name !== coordinates.name || integrity.version !== coordinates.version || integrity.platformId !== coordinates.platformId) {
            return { status: QadamVersionReadStatus.INVALID, reason: 'integrity.json names another version' }
        }
        const packageJson = await tryCatch(async (): Promise<unknown> => JSON.parse(await readFile(path.join(dir, QADAM_VERSION_STORE_LAYOUT.packageJsonFile), 'utf8')))
        if (packageJson.error !== null) {
            return { status: QadamVersionReadStatus.INVALID, reason: 'package.json is missing or not valid JSON' }
        }
        const runtimeProblem = qadamVersionStoreFormat.checkRuntime({ packageJson: packageJson.data, format: integrity.format, kind: integrity.kind })
        if (!isNil(runtimeProblem)) {
            return { status: QadamVersionReadStatus.INVALID, reason: runtimeProblem }
        }
        const entryPointPath = path.join(dir, integrity.entryPoint)
        const entryStats = await tryCatch(() => lstat(entryPointPath))
        if (entryStats.error !== null || !entryStats.data.isFile()) {
            return { status: QadamVersionReadStatus.INVALID, reason: 'the entry point is missing' }
        }
        if (verify) {
            const verified = await verifyTree({ dir, coordinates, integrity })
            if (!isNil(verified)) {
                return { status: QadamVersionReadStatus.INVALID, reason: verified }
            }
        }
        return {
            status: QadamVersionReadStatus.PRESENT,
            version: {
                coordinates,
                dir,
                entryPointPath,
                metadataPath: path.join(dir, QADAM_VERSION_STORE_LAYOUT.metadataFile),
                format: integrity.format,
                kind: integrity.kind,
                integrity,
            },
        }
    }

    const verifyTree = async ({ dir, coordinates, integrity }: VerifyTreeParams): Promise<string | null> => {
        const walked = await qadamVersionStoreTree.walk({ root: dir, limits })
        if (!walked.ok) {
            return walked.reason
        }
        const inspected = await qadamVersionStoreFormat.inspect({ dir, coordinates, tree: walked.tree })
        if (!inspected.ok) {
            return inspected.reason
        }
        const digest = await qadamVersionStoreTree.digest({ root: dir, tree: walked.tree, sync: false })
        return digest === integrity.tree.digest ? null : 'the content does not match integrity.json'
    }

    const createStaging = async (): Promise<string> => {
        const dir = path.join(stagingRoot, `${Date.now()}-${randomUUID()}`)
        await mkdir(dir, { mode: 0o700 })
        return dir
    }

    const discardStaging = async ({ stagingDir }: { stagingDir: string }): Promise<void> => {
        if (!isDirectChild({ parent: stagingRoot, child: stagingDir })) {
            throw new Error('not a staging directory of this store')
        }
        await rm(stagingDir, { recursive: true, force: true })
    }

    const commit = async ({ coordinates, stagingDir, origin }: CommitParams): Promise<QadamVersionPutResult> => {
        if (!isDirectChild({ parent: stagingRoot, child: stagingDir })) {
            throw new Error('not a staging directory of this store')
        }
        const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
        if (!validation.valid) {
            await discardStaging({ stagingDir })
            return { status: QadamVersionPutStatus.REFUSED, reason: validation.reason }
        }
        const dir = qadamVersionStoreLayout.versionDir({ root, coordinates })
        const prepared = await tryCatch(async () => {
            const staged = await prepareStaged({ stagingDir, coordinates, origin })
            if (!staged.ok) {
                return staged
            }
            const parent = await ensureDirectoryChain({ root, dir: path.dirname(dir) })
            return parent.ok ? staged : parent
        })
        if (prepared.error !== null || !prepared.data.ok) {
            await discardStaging({ stagingDir })
            if (prepared.error !== null) {
                throw prepared.error
            }
            return { status: QadamVersionPutStatus.REFUSED, reason: prepared.data.ok ? 'unreachable' : prepared.data.reason }
        }
        return publish({ stagingDir, dir, coordinates, record: prepared.data.record, attempt: 1 })
    }

    const prepareStaged = async ({ stagingDir, coordinates, origin }: PrepareStagedParams): Promise<PrepareResult> => {
        await unlink(path.join(stagingDir, QADAM_VERSION_STORE_LAYOUT.integrityFile)).catch(() => undefined)
        const walked = await qadamVersionStoreTree.walk({ root: stagingDir, limits })
        if (!walked.ok) {
            return walked
        }
        const inspected = await qadamVersionStoreFormat.inspect({ dir: stagingDir, coordinates, tree: walked.tree })
        if (!inspected.ok) {
            return inspected
        }
        const digest = await qadamVersionStoreTree.digest({ root: stagingDir, tree: walked.tree, sync: true })
        const record: QadamVersionIntegrity = {
            storeFormatVersion: STORE_FORMAT_VERSION,
            platformId: coordinates.platformId,
            name: coordinates.name,
            version: coordinates.version,
            format: inspected.format,
            kind: inspected.kind,
            entryPoint: inspected.entryPoint,
            origin,
            tree: { algorithm: 'sha512', digest, files: walked.tree.files, bytes: walked.tree.bytes },
            storedAt: new Date().toISOString(),
        }
        await writeIntegrityRecord({ dir: stagingDir, record })
        return { ok: true, record }
    }

    const publish = async ({ stagingDir, dir, coordinates, record, attempt }: PublishParams): Promise<QadamVersionPutResult> => {
        const renamed = await tryCatch(() => rename(stagingDir, dir))
        if (renamed.error === null) {
            log.info({ qadam: `${coordinates.name}@${coordinates.version}`, platformId: coordinates.platformId, origin: record.origin.kind }, '[qadamVersionStore] Stored a qadam version')
            const stored = await read({ coordinates })
            if (stored.status !== QadamVersionReadStatus.PRESENT) {
                throw new Error(`a version just stored does not read back: ${stored.status === QadamVersionReadStatus.INVALID ? stored.reason : 'absent'}`)
            }
            return { status: QadamVersionPutStatus.STORED, version: stored.version }
        }
        const taken = ['EEXIST', 'ENOTEMPTY'].some((code) => fileSystemUtils.hasErrorCode({ error: renamed.error, code }))
        if (!taken) {
            await discardStaging({ stagingDir })
            throw renamed.error
        }
        const existing = await read({ coordinates })
        if (existing.status === QadamVersionReadStatus.PRESENT) {
            await discardStaging({ stagingDir })
            if (existing.version.integrity.tree.digest !== record.tree.digest) {
                log.warn({ qadam: `${coordinates.name}@${coordinates.version}`, platformId: coordinates.platformId }, '[qadamVersionStore] The stored version differs from the one offered; the stored one is kept')
            }
            return { status: QadamVersionPutStatus.EXISTS, version: existing.version }
        }
        if (attempt >= MAX_PUBLISH_ATTEMPTS) {
            await discardStaging({ stagingDir })
            throw new Error('the version directory stayed occupied by an unreadable version')
        }
        // A damaged version moves aside rather than being deleted in place, so no reader ever sees
        // it half removed; the rename back into the free path is retried once.
        const reason = existing.status === QadamVersionReadStatus.INVALID ? existing.reason : 'absent'
        log.warn({ qadam: `${coordinates.name}@${coordinates.version}`, platformId: coordinates.platformId, reason }, '[qadamVersionStore] Replacing an unreadable version')
        const aside = path.join(trashRoot, `${Date.now()}-${randomUUID()}`)
        const moved = await tryCatch(() => rename(dir, aside))
        if (moved.error !== null && !fileSystemUtils.hasErrorCode({ error: moved.error, code: 'ENOENT' })) {
            await discardStaging({ stagingDir })
            throw moved.error
        }
        void rm(aside, { recursive: true, force: true }).catch(() => undefined)
        return publish({ stagingDir, dir, coordinates, record, attempt: attempt + 1 })
    }

    const putTarball = async ({ coordinates, tarballPath, expectedIntegrity, origin }: PutTarballParams): Promise<QadamVersionPutResult> => {
        const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
        if (!validation.valid) {
            return { status: QadamVersionPutStatus.REFUSED, reason: validation.reason }
        }
        if (!qadamVersionStoreTarball.isSupportedIntegrity({ integrity: expectedIntegrity })) {
            return { status: QadamVersionPutStatus.REFUSED, reason: 'the expected integrity is not a sha512 integrity string' }
        }
        const tarballSize = (await stat(tarballPath)).size
        if (tarballSize > limits.maxBytes) {
            return { status: QadamVersionPutStatus.REFUSED, reason: `the tarball is larger than ${limits.maxBytes} bytes` }
        }
        const actualIntegrity = await qadamVersionStoreTarball.computeIntegrity({ file: tarballPath })
        if (actualIntegrity !== expectedIntegrity) {
            return { status: QadamVersionPutStatus.REFUSED, reason: 'the tarball does not match its expected integrity' }
        }
        const stagingDir = await createStaging()
        const extracted = await tryCatch(() => qadamVersionStoreTarball.extract({ file: tarballPath, destination: stagingDir, limits }))
        if (extracted.error !== null || !extracted.data.ok) {
            await discardStaging({ stagingDir })
            if (extracted.error !== null) {
                throw extracted.error
            }
            return { status: QadamVersionPutStatus.REFUSED, reason: extracted.data.ok ? 'unreachable' : extracted.data.reason }
        }
        return commit({ coordinates, stagingDir, origin: { ...origin, tarballIntegrity: actualIntegrity } })
    }

    const listVersions = async ({ platformId }: { platformId: string | null }): Promise<QadamVersionCoordinates[]> => {
        const namespaceDir = qadamVersionStoreLayout.namespaceDir({ root, platformId })
        const topLevel = await listDirectories({ dir: namespaceDir })
        const names = (await Promise.all(topLevel
            .filter((entryName) => !qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName }))
            .map(async (entryName) => entryName.startsWith('@')
                ? (await listDirectories({ dir: path.join(namespaceDir, entryName) })).map((scoped) => `${entryName}/${scoped}`)
                : [entryName]))).flat()
        const versions = await Promise.all(names.map(async (name) => (await listDirectories({ dir: path.join(namespaceDir, ...name.split('/')) }))
            .map((version) => ({ platformId, name, version }))))
        return versions.flat()
            .filter((coordinates) => qadamVersionStoreLayout.validateCoordinates(coordinates).valid)
            .sort((a, b) => a.name === b.name ? semver.compare(a.version, b.version) : compareStrings(a.name, b.name))
    }

    return {
        root,
        read,
        has: async ({ coordinates }) => (await read({ coordinates })).status === QadamVersionReadStatus.PRESENT,
        listVersions,
        createStaging,
        discardStaging,
        commit,
        putTarball,
    }
}

const STORE_FORMAT_VERSION = 1
const MAX_PUBLISH_ATTEMPTS = 2
const MAX_INTEGRITY_FILE_BYTES = 64 * 1024
// A staging directory older than this was left by a process that died mid-write; younger ones may
// be another replica's write in progress. Seeding the whole catalogue takes minutes, not hours.
const STALE_STAGING_MS = 6 * 60 * 60 * 1000

const QadamVersionIntegrity = z.object({
    storeFormatVersion: z.literal(STORE_FORMAT_VERSION),
    platformId: z.string().nullable(),
    name: z.string(),
    version: z.string(),
    format: z.enum(QadamArtifactFormat),
    kind: z.enum(QadamArtifactKind).nullable(),
    entryPoint: z.string(),
    origin: z.object({
        kind: z.enum(QadamVersionOrigin),
        tarballIntegrity: z.string().nullable(),
    }),
    tree: z.object({
        algorithm: z.literal('sha512'),
        digest: z.string(),
        files: z.number(),
        bytes: z.number(),
    }),
    storedAt: z.string(),
})

export type QadamVersionIntegrity = z.infer<typeof QadamVersionIntegrity>

async function readIntegrityRecord({ dir }: { dir: string }): Promise<IntegrityRecordResult> {
    const filePath = path.join(dir, QADAM_VERSION_STORE_LAYOUT.integrityFile)
    const stats = await tryCatch(() => lstat(filePath))
    if (stats.error !== null || !stats.data.isFile()) {
        return { ok: false, reason: 'integrity.json is missing' }
    }
    if (stats.data.size > MAX_INTEGRITY_FILE_BYTES) {
        return { ok: false, reason: 'integrity.json is too large' }
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(await readFile(filePath, 'utf8')))
    if (parsed.error !== null) {
        return { ok: false, reason: 'integrity.json is not valid JSON' }
    }
    const record = QadamVersionIntegrity.safeParse(parsed.data)
    if (!record.success) {
        return { ok: false, reason: 'integrity.json is not a record this platform reads' }
    }
    // The entry point is re-checked here because a reader joins it to the version directory.
    const entryPoint = path.posix.normalize(record.data.entryPoint)
    if (entryPoint !== record.data.entryPoint || path.posix.isAbsolute(entryPoint) || entryPoint.split('/').includes('..')) {
        return { ok: false, reason: 'integrity.json names an entry point outside the version' }
    }
    return { ok: true, record: record.data }
}

async function writeIntegrityRecord({ dir, record }: { dir: string, record: QadamVersionIntegrity }): Promise<void> {
    const handle = await open(path.join(dir, QADAM_VERSION_STORE_LAYOUT.integrityFile), 'wx', 0o644)
    try {
        await handle.writeFile(JSON.stringify(record, null, 2) + '\n')
        await handle.datasync()
    }
    finally {
        await handle.close()
    }
}

// Creates the version's parent directories one level at a time below the store root, refusing a
// component that exists as anything but a real directory. `mkdir -p` would follow a symlinked
// component and create directories wherever it points.
async function ensureDirectoryChain({ root, dir }: { root: string, dir: string }): Promise<{ ok: true } | { ok: false, reason: string }> {
    const components = path.relative(root, dir).split(path.sep)
    let current = root
    for (const component of components) {
        current = path.join(current, component)
        const created = await tryCatch(() => mkdir(current))
        if (created.error !== null && !fileSystemUtils.hasErrorCode({ error: created.error, code: 'EEXIST' })) {
            throw created.error
        }
        const stats = await lstat(current)
        if (!stats.isDirectory()) {
            return { ok: false, reason: 'the version path goes through a symlink or a file' }
        }
    }
    return { ok: true }
}

async function isCaseSensitive({ dir }: { dir: string }): Promise<boolean> {
    const probe = path.join(dir, `case-probe-${randomUUID()}`)
    await (await open(probe, 'wx')).close()
    try {
        const upper = await tryCatch(() => lstat(path.join(dir, path.basename(probe).toUpperCase())))
        return upper.error !== null
    }
    finally {
        await unlink(probe).catch(() => undefined)
    }
}

async function removeLeftovers({ root, log }: { root: string, log: QadamVersionStoreLogger }): Promise<void> {
    const trashRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.trashDir)
    const stagingRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.stagingDir)
    const trash = await listDirectories({ dir: trashRoot })
    const staging = (await listDirectories({ dir: stagingRoot })).filter((name) => isStale({ name }))
    const removals = [...trash.map((name) => path.join(trashRoot, name)), ...staging.map((name) => path.join(stagingRoot, name))]
    const results = await Promise.allSettled(removals.map((dir) => rm(dir, { recursive: true, force: true })))
    const failed = results.filter((result) => result.status === 'rejected').length
    if (failed > 0) {
        log.warn({ failed }, '[qadamVersionStore] Could not remove some leftover staging or trash directories')
    }
}

// Age from the `<ms>-` prefix the store gives every staging directory, not from mtime: renames do
// not update a directory's own mtime. A name without one is not the store's and is left alone.
function isStale({ name }: { name: string }): boolean {
    const createdAt = Number.parseInt(name.split('-')[0] ?? '', 10)
    return Number.isFinite(createdAt) && Date.now() - createdAt > STALE_STAGING_MS
}

async function listDirectories({ dir }: { dir: string }): Promise<string[]> {
    const entries = await tryCatch(() => readdir(dir, { withFileTypes: true }))
    if (entries.error !== null) {
        if (fileSystemUtils.hasErrorCode({ error: entries.error, code: 'ENOENT' })) {
            return []
        }
        throw entries.error
    }
    return entries.data.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

function isDirectChild({ parent, child }: { parent: string, child: string }): boolean {
    const relative = path.relative(parent, path.resolve(child))
    return relative !== '' && !relative.includes(path.sep) && !relative.startsWith('..')
}

function compareStrings(a: string, b: string): number {
    if (a === b) {
        return 0
    }
    return a < b ? -1 : 1
}

function describeErrorCode({ error }: { error: unknown }): string {
    return error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'
}

export type QadamVersionStoreLogger = {
    info: (obj: Record<string, unknown>, msg: string) => void
    warn: (obj: Record<string, unknown>, msg: string) => void
}

export type StoredQadamVersion = {
    coordinates: QadamVersionCoordinates
    dir: string
    // Absolute path of the file Node loads for this version (`package.json` `main`).
    entryPointPath: string
    metadataPath: string
    format: QadamArtifactFormat
    kind: QadamArtifactKind | null
    integrity: QadamVersionIntegrity
}

export type QadamVersionReadResult =
    | { status: QadamVersionReadStatus.PRESENT, version: StoredQadamVersion }
    | { status: QadamVersionReadStatus.ABSENT }
    | { status: QadamVersionReadStatus.INVALID, reason: string }

export type QadamVersionPutResult =
    | { status: QadamVersionPutStatus.STORED | QadamVersionPutStatus.EXISTS, version: StoredQadamVersion }
    | { status: QadamVersionPutStatus.REFUSED, reason: string }

export type QadamVersionOriginInput = {
    kind: QadamVersionOrigin
}

export type QadamVersionStore = {
    root: string
    // `verify` re-walks and re-hashes the whole version; without it a read checks the integrity
    // record, `package.json` and the entry point only.
    read: (params: ReadParams) => Promise<QadamVersionReadResult>
    has: (params: { coordinates: QadamVersionCoordinates }) => Promise<boolean>
    listVersions: (params: { platformId: string | null }) => Promise<QadamVersionCoordinates[]>
    // For a writer that assembles a version itself (an install, #806): stage, fill, commit.
    createStaging: () => Promise<string>
    discardStaging: (params: { stagingDir: string }) => Promise<void>
    commit: (params: CommitParams) => Promise<QadamVersionPutResult>
    putTarball: (params: PutTarballParams) => Promise<QadamVersionPutResult>
}

type OpenParams = {
    root: string
    log: QadamVersionStoreLogger
    limits?: QadamVersionTarballLimits
}

type OpenResult = { ok: true, store: QadamVersionStore } | { ok: false, reason: string }

type CreateStoreParams = {
    root: string
    log: QadamVersionStoreLogger
    limits: QadamVersionTarballLimits
}

type ReadParams = {
    coordinates: QadamVersionCoordinates
    verify?: boolean
}

type VerifyTreeParams = {
    dir: string
    coordinates: QadamVersionCoordinates
    integrity: QadamVersionIntegrity
}

type CommitParams = {
    coordinates: QadamVersionCoordinates
    stagingDir: string
    origin: QadamVersionIntegrity['origin']
}

type PutTarballParams = {
    coordinates: QadamVersionCoordinates
    tarballPath: string
    // `sha512-<base64>`, as npm's `dist.integrity` and an archive index carry it.
    expectedIntegrity: string
    origin: QadamVersionOriginInput
}

type PrepareStagedParams = {
    stagingDir: string
    coordinates: QadamVersionCoordinates
    origin: QadamVersionIntegrity['origin']
}

type PrepareResult = { ok: true, record: QadamVersionIntegrity } | { ok: false, reason: string }

type PublishParams = {
    stagingDir: string
    dir: string
    coordinates: QadamVersionCoordinates
    record: QadamVersionIntegrity
    attempt: number
}

type IntegrityRecordResult = { ok: true, record: QadamVersionIntegrity } | { ok: false, reason: string }

