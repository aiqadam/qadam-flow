import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import semver from 'semver'
import { fileSystemUtils } from '../file-system-utils'
import { qadamVersionStoreFormat } from './qadam-version-store-format'
import { QADAM_VERSION_STORE_LAYOUT, QadamVersionCoordinates, qadamVersionStoreLayout } from './qadam-version-store-layout'
import {
    DEFAULT_QADAM_VERSION_STORE_LIMITS,
    QADAM_VERSION_STORE_FORMAT_VERSION,
    QadamVersionIntegrity,
    QadamVersionOrigin,
    QadamVersionReadResult,
    QadamVersionReadStatus,
    qadamVersionStoreReader,
    QadamVersionStoreReader,
    StoredQadamVersion,
} from './qadam-version-store-read'
import { qadamVersionStoreTarball, QadamVersionTarballLimits } from './qadam-version-store-tarball'
import { qadamVersionStoreTree } from './qadam-version-store-tree'

export { DEFAULT_QADAM_VERSION_STORE_LIMITS, QadamVersionOrigin, QadamVersionReadStatus }
export type { QadamVersionIntegrity, QadamVersionReadResult, QadamVersionStoreReader, StoredQadamVersion }

export enum QadamVersionPutStatus {
    STORED = 'stored',
    // That version was already there, or another writer stored it first. A version is never
    // overwritten (ADR-0001: a version is never reused).
    EXISTS = 'exists',
    REFUSED = 'refused',
}

// The versioned qadam store of ADR-0003 on a persistent volume, by `name@version`, per namespace.
//
// The engine loads an official qadam version from here when the store holds it, in the forked
// execution modes (#779, `openForReading`). The API's metadata, the worker's provisioning and the
// isolate modes do not resolve through it yet; #779 tracks the rest.
//
// Writes are atomic: a version is assembled in `<root>/.staging/`, checked, given its
// `integrity.json`, flushed, and renamed into place, so a reader sees a complete version or none.
// Two writers of the same version on a shared volume (replicas, rolling upgrades) both stage; one
// rename wins and the other finds the version present and discards its copy. Only a DAMAGED
// version is ever replaced.
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
            return { ok: false, reason: `the store directory cannot be prepared (${qadamVersionStoreReader.describeErrorCode({ error: prepared.error })})` }
        }
        const realRoot = prepared.data
        // A stored version resolves packages the way Node does, upward from its own directory. A
        // `node_modules` at or above the root would answer for anything the platform does not
        // provide, so a version could silently run on an app's own dependencies (ADR-0003: the
        // platform provides `@aiqadam/*` and `zod` only).
        const reachable = await qadamVersionStoreReader.findNodeModulesAbove({ dir: realRoot })
        if (!isNil(reachable)) {
            return { ok: false, reason: `stored versions could resolve packages from ${reachable}; put the store outside any directory with a node_modules` }
        }
        const caseSensitive = await tryCatch(() => isCaseSensitive({ dir: path.join(realRoot, QADAM_VERSION_STORE_LAYOUT.stagingDir) }))
        if (caseSensitive.error !== null) {
            return { ok: false, reason: `the store directory is not writable (${qadamVersionStoreReader.describeErrorCode({ error: caseSensitive.error })})` }
        }
        // Platform ids and prerelease versions differ by case alone; on a case-insensitive
        // filesystem two platforms could share a directory, so the store refuses to open there.
        if (!caseSensitive.data) {
            return { ok: false, reason: 'the store directory is on a case-insensitive filesystem' }
        }
        const cleaned = await tryCatch(() => removeLeftovers({ root: realRoot, log }))
        if (cleaned.error !== null) {
            log.warn({ error: qadamVersionStoreReader.describeErrorCode({ error: cleaned.error }) }, '[qadamVersionStore] Could not look for leftover staging or trash directories')
        }
        return { ok: true, store: createStore({ root: realRoot, log, limits }) }
    },

}

function createStore({ root, log, limits }: CreateStoreParams): QadamVersionStore {
    const stagingRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.stagingDir)
    const trashRoot = path.join(root, QADAM_VERSION_STORE_LAYOUT.trashDir)
    const { read, readAt } = qadamVersionStoreReader.create({ root, limits })

    const createStaging = async (): Promise<string> => {
        const dir = path.join(stagingRoot, `${Date.now()}-${randomUUID()}`)
        // Private while it is written; opened to readers (0755) just before it is renamed into place.
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
        // A sandboxed engine reading the store may run as another user (#779).
        await chmod(stagingDir, 0o755)
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
            storeFormatVersion: QADAM_VERSION_STORE_FORMAT_VERSION,
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
        const qadam = `${coordinates.name}@${coordinates.version}`
        const renamed = await tryCatch(() => rename(stagingDir, dir))
        if (renamed.error === null) {
            log.info({ qadam, platformId: coordinates.platformId, origin: record.origin.kind }, '[qadamVersionStore] Stored a qadam version')
            const stored = await read({ coordinates })
            if (stored.status !== QadamVersionReadStatus.PRESENT) {
                throw new Error(`a version just stored does not read back: ${stored.status}`)
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
                log.warn({ qadam, platformId: coordinates.platformId }, '[qadamVersionStore] The stored version differs from the one offered; the stored one is kept')
            }
            return { status: QadamVersionPutStatus.EXISTS, version: existing.version }
        }
        if (existing.status !== QadamVersionReadStatus.DAMAGED && existing.status !== QadamVersionReadStatus.ABSENT) {
            await discardStaging({ stagingDir })
            const reason = existing.reason
            log.warn({ qadam, platformId: coordinates.platformId, status: existing.status, reason }, '[qadamVersionStore] A version this release cannot use is stored there; it is kept')
            return { status: QadamVersionPutStatus.REFUSED, reason: `a version this release cannot use is stored there and is kept (${existing.status}: ${reason})` }
        }
        if (attempt >= MAX_PUBLISH_ATTEMPTS) {
            await discardStaging({ stagingDir })
            throw new Error('the version directory stayed occupied')
        }
        if (existing.status === QadamVersionReadStatus.ABSENT) {
            return publish({ stagingDir, dir, coordinates, record, attempt: attempt + 1 })
        }
        return replaceDamaged({ stagingDir, dir, coordinates, record, attempt, reason: existing.reason })
    }

    // A damaged version moves aside rather than being deleted in place, so no reader ever sees it
    // half removed. What was moved is read again, because another writer may have replaced the
    // damaged version between this writer's read and its move: anything that is not DAMAGED — a good
    // version, or one another release or host wrote and this one cannot use — is put back and kept.
    // Only a moved version that is still DAMAGED is deleted; one that cannot be put back stays in
    // `.trash/` until the stale-leftover cleanup, rather than being deleted now.
    const replaceDamaged = async ({ stagingDir, dir, coordinates, record, attempt, reason }: ReplaceDamagedParams): Promise<QadamVersionPutResult> => {
        const qadam = `${coordinates.name}@${coordinates.version}`
        log.warn({ qadam, platformId: coordinates.platformId, reason }, '[qadamVersionStore] Replacing a damaged version')
        const aside = path.join(trashRoot, `${Date.now()}-${randomUUID()}`)
        const moved = await tryCatch(() => rename(dir, aside))
        if (moved.error !== null) {
            if (fileSystemUtils.hasErrorCode({ error: moved.error, code: 'ENOENT' })) {
                return publish({ stagingDir, dir, coordinates, record, attempt: attempt + 1 })
            }
            await discardStaging({ stagingDir })
            throw moved.error
        }
        const movedVersion = await readAt({ dir: aside, coordinates, verify: false })
        if (movedVersion.status === QadamVersionReadStatus.DAMAGED) {
            void rm(aside, { recursive: true, force: true }).catch(() => undefined)
            return publish({ stagingDir, dir, coordinates, record, attempt: attempt + 1 })
        }
        const restored = await tryCatch(() => rename(aside, dir))
        if (restored.error !== null) {
            log.warn({ qadam, platformId: coordinates.platformId, status: movedVersion.status, trashEntry: path.basename(aside), error: qadamVersionStoreReader.describeErrorCode({ error: restored.error }) }, '[qadamVersionStore] Could not put back a version another writer stored; it stays in .trash until the leftover cleanup')
            return publish({ stagingDir, dir, coordinates, record, attempt: attempt + 1 })
        }
        await discardStaging({ stagingDir })
        const kept = await read({ coordinates })
        if (kept.status === QadamVersionReadStatus.PRESENT) {
            return { status: QadamVersionPutStatus.EXISTS, version: kept.version }
        }
        const keptReason = 'reason' in kept ? kept.reason : kept.status
        return { status: QadamVersionPutStatus.REFUSED, reason: `a version this release cannot use is stored there and is kept (${kept.status}: ${keptReason})` }
    }

    const putTarball = async ({ coordinates, tarballPath, expectedIntegrity, origin }: PutTarballParams): Promise<QadamVersionPutResult> => {
        const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
        if (!validation.valid) {
            return { status: QadamVersionPutStatus.REFUSED, reason: validation.reason }
        }
        if (!qadamVersionStoreTarball.isSupportedIntegrity({ integrity: expectedIntegrity })) {
            return { status: QadamVersionPutStatus.REFUSED, reason: 'the expected integrity is not a sha512 integrity string' }
        }
        const stagingDir = await createStaging()
        // The integrity is computed from the bytes extraction read, and checked before anything
        // extracted is used (`qadamVersionStoreTarball.extract`).
        const extracted = await tryCatch(() => qadamVersionStoreTarball.extract({ file: tarballPath, destination: stagingDir, limits }))
        if (extracted.error !== null) {
            await discardStaging({ stagingDir })
            throw extracted.error
        }
        if (!extracted.data.ok || extracted.data.integrity !== expectedIntegrity) {
            await discardStaging({ stagingDir })
            return { status: QadamVersionPutStatus.REFUSED, reason: extracted.data.ok ? 'the tarball does not match its expected integrity' : extracted.data.reason }
        }
        return commit({ coordinates, stagingDir, origin: { ...origin, tarballIntegrity: extracted.data.integrity } })
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

// The first rename, one after a damaged version moved aside or vanished, and one after a race.
const MAX_PUBLISH_ATTEMPTS = 3
// A staging or trash directory older than this was left by a process that died mid-write; younger
// ones may be another replica's write in progress. Seeding the whole catalogue takes minutes.
const STALE_LEFTOVER_MS = 6 * 60 * 60 * 1000


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
        const created = await tryCatch(() => mkdir(current, { mode: 0o755 }))
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
    const trash = (await listDirectories({ dir: trashRoot })).filter((name) => isStale({ name }))
    const staging = (await listDirectories({ dir: stagingRoot })).filter((name) => isStale({ name }))
    const removals = [...trash.map((name) => path.join(trashRoot, name)), ...staging.map((name) => path.join(stagingRoot, name))]
    const results = await Promise.allSettled(removals.map((dir) => rm(dir, { recursive: true, force: true })))
    const failed = results.filter((result) => result.status === 'rejected').length
    if (failed > 0) {
        log.warn({ failed }, '[qadamVersionStore] Could not remove some leftover staging or trash directories')
    }
}

// Age from the `<ms>-` prefix the store gives every staging and trash directory, not from mtime:
// renames do not update a directory's own mtime. A name without one is not the store's and is left
// alone.
function isStale({ name }: { name: string }): boolean {
    const createdAt = Number.parseInt(name.split('-')[0] ?? '', 10)
    return Number.isFinite(createdAt) && Date.now() - createdAt > STALE_LEFTOVER_MS
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
    return relative !== '' && !relative.includes(path.sep) && !qadamVersionStoreLayout.isOutside({ relative })
}

function compareStrings(a: string, b: string): number {
    if (a === b) {
        return 0
    }
    return a < b ? -1 : 1
}





export type QadamVersionStoreLogger = {
    info: (obj: Record<string, unknown>, msg: string) => void
    warn: (obj: Record<string, unknown>, msg: string) => void
}

export type QadamVersionPutResult =
    | { status: QadamVersionPutStatus.STORED | QadamVersionPutStatus.EXISTS, version: StoredQadamVersion }
    | { status: QadamVersionPutStatus.REFUSED, reason: string }

export type QadamVersionOriginInput = {
    kind: QadamVersionOrigin
}

export type QadamVersionStore = QadamVersionStoreReader & {
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

type ReplaceDamagedParams = PublishParams & {
    reason: string
}


