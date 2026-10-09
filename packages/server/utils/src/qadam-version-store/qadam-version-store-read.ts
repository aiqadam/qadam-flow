import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { z } from 'zod'
import { fileSystemUtils } from '../file-system-utils'
import { QadamArtifactFormat, QadamArtifactKind, qadamVersionStoreFormat } from './qadam-version-store-format'
import { qadamVersionStoreFs } from './qadam-version-store-fs'
import { QADAM_VERSION_STORE_LAYOUT, QadamVersionCoordinates, qadamVersionStoreLayout } from './qadam-version-store-layout'
import { QadamVersionStoreLimits, qadamVersionStoreTree } from './qadam-version-store-tree'

// The read side of the qadam version store: what a version on disk must look like to be loaded, and
// nothing that writes. Kept apart from `qadam-version-store.ts` so a process that only loads from
// the store (the engine, #779) carries no write or tarball code; the writer builds on this reader.
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
    // The store's own files are wrong: `integrity.json` missing or not JSON, a record naming other
    // coordinates, a missing entry point, content that no longer matches its digest. The only state
    // a writer replaces.
    DAMAGED = 'damaged',
    // Intact, but not usable by this release on this host: a newer store or artifact format, a
    // value a later release added, native modules built for another OS, CPU, libc or Node major.
    // Never replaced: the release or host that wrote it can still read it.
    UNSUPPORTED = 'unsupported',
    // An I/O error other than "not found" (EACCES, EIO, EMFILE, …). Never replaced: the error says
    // nothing about the version.
    UNREADABLE = 'unreadable',
    // Coordinates that can never name a version.
    INVALID_COORDINATES = 'invalid-coordinates',
}

export const DEFAULT_QADAM_VERSION_STORE_LIMITS: QadamVersionStoreLimits & { maxFileBytes: number } = {
    // `bundle-with-node-modules` versions carry a dependency closure: text-helper's is 1,454 files.
    maxEntries: 100_000,
    maxBytes: 2 * 1024 * 1024 * 1024,
    maxFileBytes: 512 * 1024 * 1024,
}

// The `storeFormatVersion` of every `integrity.json` this release writes and fully reads.
export const QADAM_VERSION_STORE_FORMAT_VERSION = 1

export const qadamVersionStoreReader = {
    // For a process that only loads from the store and must never write to it: a worker and its
    // engines (#779). It repeats `qadamVersionStore.open`'s `node_modules` check and skips the rest,
    // because they write: the directories `open` creates, its case-sensitivity probe and its
    // leftover cleanup. The app, which seeds the store, runs `open`.
    open: async ({ root, limits = DEFAULT_QADAM_VERSION_STORE_LIMITS }: OpenReaderParams): Promise<OpenReaderResult> => {
        const real = await tryCatch(() => realpath(path.resolve(root)))
        if (real.error !== null) {
            return { ok: false, reason: `the store directory cannot be read (${qadamVersionStoreFs.describeErrorCode({ error: real.error })})` }
        }
        const reachable = await qadamVersionStoreFs.findNodeModulesAbove({ dir: real.data })
        if (!isNil(reachable)) {
            return { ok: false, reason: 'stored versions could resolve packages from a node_modules above the store' }
        }
        const { read } = qadamVersionStoreReader.create({ root: real.data, limits })
        return { ok: true, reader: { root: real.data, read } }
    },

    // Reads versions below `root`, which the caller has already resolved to its real path.
    create: ({ root, limits }: CreateReaderParams): StoreReadFunctions => {
        const read = async ({ coordinates, verify = false }: ReadParams): Promise<QadamVersionReadResult> => {
            const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
            if (!validation.valid) {
                return { status: QadamVersionReadStatus.INVALID_COORDINATES, reason: validation.reason }
            }
            return readAt({ dir: qadamVersionStoreLayout.versionDir({ root, coordinates }), coordinates, verify })
        }

        // Reads the version in `dir`, which is its layout path, or the place a writer just moved it to.
        const readAt = async ({ dir, coordinates, verify }: ReadAtParams): Promise<QadamVersionReadResult> => {
            const dirStats = await tryCatch(() => lstat(dir))
            if (dirStats.error !== null) {
                return fileSystemUtils.hasErrorCode({ error: dirStats.error, code: 'ENOENT' })
                    ? { status: QadamVersionReadStatus.ABSENT }
                    : unreadable({ what: 'the version directory', error: dirStats.error })
            }
            if (!dirStats.data.isDirectory()) {
                return damaged('the version path is not a directory')
            }
            // A directory of the path replaced by a symlink would make this version live somewhere
            // else on the host; the real path must be the one the layout names.
            const real = await tryCatch(() => realpath(dir))
            if (real.error !== null) {
                return unreadable({ what: 'the version directory', error: real.error })
            }
            if (real.data !== dir) {
                return damaged('the version path goes through a symlink')
            }
            const record = await readIntegrityRecord({ dir })
            if (!record.ok) {
                return record.problem
            }
            const integrity = record.record
            if (integrity.name !== coordinates.name || integrity.version !== coordinates.version || integrity.platformId !== coordinates.platformId) {
                return damaged('integrity.json names another version')
            }
            const packageJsonPath = path.join(dir, QADAM_VERSION_STORE_LAYOUT.packageJsonFile)
            const packageJsonStats = await tryCatch(() => lstat(packageJsonPath))
            if (packageJsonStats.error === null && !packageJsonStats.data.isFile()) {
                return damaged('package.json is not a regular file')
            }
            const packageJson = await readJson({ filePath: packageJsonPath, what: 'package.json' })
            if (!packageJson.ok) {
                return packageJson.problem
            }
            const runtimeProblem = qadamVersionStoreFormat.checkRuntime({ packageJson: packageJson.value, format: integrity.format, kind: integrity.kind })
            if (!isNil(runtimeProblem)) {
                return runtimeProblem.unsupported ? unsupported(runtimeProblem.reason) : damaged(runtimeProblem.reason)
            }
            const entryPointPath = path.join(dir, integrity.entryPoint)
            const entryStats = await tryCatch(() => lstat(entryPointPath))
            if (entryStats.error !== null && !fileSystemUtils.hasErrorCode({ error: entryStats.error, code: 'ENOENT' })) {
                return unreadable({ what: 'the entry point', error: entryStats.error })
            }
            if (entryStats.error !== null || !entryStats.data.isFile()) {
                return damaged('the entry point is missing')
            }
            // A directory on the way may be a symlink a package manager wrote; the file Node loads must
            // still be inside the version.
            const entryReal = await tryCatch(() => realpath(entryPointPath))
            if (entryReal.error !== null) {
                return unreadable({ what: 'the entry point', error: entryReal.error })
            }
            const entryRelative = path.relative(dir, entryReal.data)
            if (entryRelative === '' || qadamVersionStoreLayout.isOutside({ relative: entryRelative })) {
                return damaged('the entry point resolves outside the version')
            }
            if (verify) {
                const verified = await verifyTree({ dir, coordinates, integrity })
                if (!isNil(verified)) {
                    return verified
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

        const verifyTree = async ({ dir, coordinates, integrity }: VerifyTreeParams): Promise<ReadProblem | null> => {
            const walked = await tryCatch(() => qadamVersionStoreTree.walk({ root: dir, limits }))
            if (walked.error !== null) {
                return unreadable({ what: 'the version', error: walked.error })
            }
            if (!walked.data.ok) {
                return damaged(walked.data.reason)
            }
            const tree = walked.data.tree
            const inspected = await qadamVersionStoreFormat.inspect({ dir, coordinates, tree })
            if (!inspected.ok) {
                return inspected.unsupported ? unsupported(inspected.reason) : damaged(inspected.reason)
            }
            const digest = await tryCatch(() => qadamVersionStoreTree.digest({ root: dir, tree, sync: false }))
            if (digest.error !== null) {
                return unreadable({ what: 'the version', error: digest.error })
            }
            return digest.data === integrity.tree.digest ? null : damaged('the content does not match integrity.json')
        }

        return { read, readAt }
    },
}

const MAX_INTEGRITY_FILE_BYTES = 64 * 1024

const QadamVersionIntegrity = z.object({
    storeFormatVersion: z.literal(QADAM_VERSION_STORE_FORMAT_VERSION),
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

// The same record with every enumerated value as a plain string: a record that matches this but
// not the one above carries a value a later release added, which is unsupported, not damaged.
const IntegrityRecordShape = QadamVersionIntegrity.extend({
    format: z.string(),
    kind: z.string().nullable(),
    origin: z.object({
        kind: z.string(),
        tarballIntegrity: z.string().nullable(),
    }),
    tree: z.object({
        algorithm: z.string(),
        digest: z.string(),
        files: z.number(),
        bytes: z.number(),
    }),
})

const IntegrityRecordEnvelope = z.object({ storeFormatVersion: z.number().int().positive() }).loose()

export type QadamVersionIntegrity = z.infer<typeof QadamVersionIntegrity>

async function readIntegrityRecord({ dir }: { dir: string }): Promise<IntegrityRecordResult> {
    const filePath = path.join(dir, QADAM_VERSION_STORE_LAYOUT.integrityFile)
    const stats = await tryCatch(() => lstat(filePath))
    if (stats.error !== null) {
        return { ok: false, problem: fileSystemUtils.hasErrorCode({ error: stats.error, code: 'ENOENT' }) ? damaged('integrity.json is missing') : unreadable({ what: 'integrity.json', error: stats.error }) }
    }
    if (!stats.data.isFile()) {
        return { ok: false, problem: damaged('integrity.json is not a regular file') }
    }
    // This release never writes a record this large, so a larger one comes from a later release
    // (persisted signatures, #780): unsupported here, never damaged.
    if (stats.data.size > MAX_INTEGRITY_FILE_BYTES) {
        return { ok: false, problem: unsupported(`integrity.json is larger than this release writes (${MAX_INTEGRITY_FILE_BYTES} bytes)`) }
    }
    const parsed = await readJson({ filePath, what: 'integrity.json' })
    if (!parsed.ok) {
        return parsed
    }
    const envelope = IntegrityRecordEnvelope.safeParse(parsed.value)
    if (!envelope.success) {
        return { ok: false, problem: damaged('integrity.json is not a store record') }
    }
    if (envelope.data.storeFormatVersion > QADAM_VERSION_STORE_FORMAT_VERSION) {
        return { ok: false, problem: unsupported(`integrity.json is store format ${envelope.data.storeFormatVersion}, written by a later release`) }
    }
    const record = QadamVersionIntegrity.safeParse(parsed.value)
    if (!record.success) {
        return { ok: false, problem: IntegrityRecordShape.safeParse(parsed.value).success
            ? unsupported('integrity.json carries a value a later release added')
            : damaged('integrity.json is not a store record') }
    }
    // The entry point is re-checked here because a reader joins it to the version directory.
    const entryPoint = path.posix.normalize(record.data.entryPoint)
    if (entryPoint !== record.data.entryPoint || path.posix.isAbsolute(entryPoint) || entryPoint.split('/').includes('..')) {
        return { ok: false, problem: damaged('integrity.json names an entry point outside the version') }
    }
    return { ok: true, record: record.data }
}
// "Not found" and "not JSON" are damage; any other read error is the filesystem's, not the version's.
async function readJson({ filePath, what }: { filePath: string, what: string }): Promise<JsonResult> {
    const content = await tryCatch(() => readFile(filePath, 'utf8'))
    if (content.error !== null) {
        return { ok: false, problem: fileSystemUtils.hasErrorCode({ error: content.error, code: 'ENOENT' }) ? damaged(`${what} is missing`) : unreadable({ what, error: content.error }) }
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(content.data))
    return parsed.error === null ? { ok: true, value: parsed.data } : { ok: false, problem: damaged(`${what} is not valid JSON`) }
}

function damaged(reason: string): ReadProblem {
    return { status: QadamVersionReadStatus.DAMAGED, reason }
}

function unsupported(reason: string): ReadProblem {
    return { status: QadamVersionReadStatus.UNSUPPORTED, reason }
}

function unreadable({ what, error }: { what: string, error: unknown }): ReadProblem {
    return { status: QadamVersionReadStatus.UNREADABLE, reason: `${what} cannot be read (${qadamVersionStoreFs.describeErrorCode({ error })})` }
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
    | ReadProblem

export type QadamVersionStoreReader = {
    root: string
    // `verify` re-walks and re-hashes the whole version; without it a read checks the integrity
    // record, `package.json` and the entry point only.
    read: (params: ReadParams) => Promise<QadamVersionReadResult>
}

export type StoreReadFunctions = {
    read: (params: ReadParams) => Promise<QadamVersionReadResult>
    // Reads the version in `dir`, which is its layout path, or the place a writer just moved it to.
    readAt: (params: ReadAtParams) => Promise<QadamVersionReadResult>
}

type ReadProblem = {
    status: QadamVersionReadStatus.DAMAGED | QadamVersionReadStatus.UNSUPPORTED | QadamVersionReadStatus.UNREADABLE | QadamVersionReadStatus.INVALID_COORDINATES
    reason: string
}

type OpenReaderParams = {
    root: string
    limits?: QadamVersionStoreLimits
}

type OpenReaderResult = { ok: true, reader: QadamVersionStoreReader } | { ok: false, reason: string }

type CreateReaderParams = {
    root: string
    limits: QadamVersionStoreLimits
}

type ReadParams = {
    coordinates: QadamVersionCoordinates
    verify?: boolean
}

type ReadAtParams = {
    dir: string
    coordinates: QadamVersionCoordinates
    verify: boolean
}

type VerifyTreeParams = {
    dir: string
    coordinates: QadamVersionCoordinates
    integrity: QadamVersionIntegrity
}

type IntegrityRecordResult = { ok: true, record: QadamVersionIntegrity } | { ok: false, problem: ReadProblem }

type JsonResult = { ok: true, value: unknown } | { ok: false, problem: ReadProblem }
