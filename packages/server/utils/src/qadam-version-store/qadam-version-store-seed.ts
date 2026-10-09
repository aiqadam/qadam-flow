import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { z } from 'zod'
import { fileSystemUtils } from '../file-system-utils'
import { QadamVersionOrigin, QadamVersionPutStatus, QadamVersionReadStatus, QadamVersionStore, QadamVersionStoreLogger } from './qadam-version-store'

// What an image ships for the store (ADR-0003 "seeded by the image at start-up"): the directory
// `build-qadam-artifacts.mjs --pack` writes (#804) — one `npm pack` tarball per version, the same
// file that goes to npm, and `archive-index.json` naming each with its sha512 integrity:
//
//   <seed>/archive-index.json   { formatVersion: 1, artifacts: [{ name, version, kind, file, integrity, ... }] }
//   <seed>/<file>.tgz
//
// Which versions an image carries — every official qadam (`:fat`) or the core ones (`:slim`) —
// is #807's. An image without a seed directory seeds nothing, which is every image until then.
export const QADAM_VERSION_STORE_SEED_INDEX = 'archive-index.json'

export enum SeedStatus {
    DONE = 'done',
    // The image carries no seed: nothing to do.
    NO_SEED = 'no-seed',
    // The image carries a seed this platform cannot read: a build problem, reported loudly.
    INVALID_SEED = 'invalid-seed',
}

export const qadamVersionStoreSeed = {
    // Idempotent and safe to run from several processes at once on one volume. A version already
    // stored is left as it is, and so is one this release cannot use but that is not damaged (a later
    // release's format, another host's native build, an I/O error): only a DAMAGED version is
    // replaced. Two processes storing the same version race on an atomic rename
    // that one wins (`qadamVersionStore`). It never removes a version. Callers that run it from
    // every replica should still hold one lock around it (the API holds a `distributedLock`), so
    // the replicas do not all hash and extract the same tarballs at once.
    seedFromImage: async ({ store, seedDir, log }: SeedParams): Promise<SeedReport> => {
        const index = await readSeedIndex({ seedDir })
        if (!index.ok) {
            return { status: index.status, reason: index.reason, stored: 0, present: 0, kept: 0, failed: [] }
        }
        const outcomes: SeedOutcome[] = []
        for (const artifact of index.artifacts) {
            outcomes.push(await seedOne({ store, seedDir, artifact, log }))
        }
        const failed = outcomes.flatMap((outcome) => outcome.kind === 'failed' ? [{ qadam: outcome.qadam, reason: outcome.reason }] : [])
        return {
            status: SeedStatus.DONE,
            reason: null,
            stored: outcomes.filter((outcome) => outcome.kind === 'stored').length,
            present: outcomes.filter((outcome) => outcome.kind === 'present').length,
            kept: outcomes.filter((outcome) => outcome.kind === 'kept').length,
            failed,
        }
    },
}

const MAX_INDEX_BYTES = 16 * 1024 * 1024
// A plain file name inside the seed directory; `npm pack` names scoped packages `scope-name-1.2.3.tgz`.
const TARBALL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/

const SeedArtifact = z.object({
    name: z.string(),
    version: z.string(),
    file: z.string(),
    integrity: z.string(),
}).loose()

const SeedIndex = z.object({
    formatVersion: z.literal(1),
    artifacts: z.array(SeedArtifact),
})

async function readSeedIndex({ seedDir }: { seedDir: string }): Promise<SeedIndexResult> {
    const indexPath = path.join(seedDir, QADAM_VERSION_STORE_SEED_INDEX)
    const stats = await tryCatch(() => lstat(indexPath))
    if (stats.error !== null) {
        return fileSystemUtils.hasErrorCode({ error: stats.error, code: 'ENOENT' }) || fileSystemUtils.hasErrorCode({ error: stats.error, code: 'ENOTDIR' })
            ? { ok: false, status: SeedStatus.NO_SEED, reason: 'the image carries no seed' }
            : { ok: false, status: SeedStatus.INVALID_SEED, reason: 'the seed index cannot be read' }
    }
    if (!stats.data.isFile() || stats.data.size > MAX_INDEX_BYTES) {
        return { ok: false, status: SeedStatus.INVALID_SEED, reason: 'the seed index is not a regular file of a sane size' }
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(await readFile(indexPath, 'utf8')))
    if (parsed.error !== null) {
        return { ok: false, status: SeedStatus.INVALID_SEED, reason: 'the seed index is not valid JSON' }
    }
    const index = SeedIndex.safeParse(parsed.data)
    if (!index.success) {
        return { ok: false, status: SeedStatus.INVALID_SEED, reason: 'the seed index is not a version-1 archive index' }
    }
    return { ok: true, artifacts: index.data.artifacts }
}

async function seedOne({ store, seedDir, artifact, log }: SeedOneParams): Promise<SeedOutcome> {
    const qadam = `${artifact.name}@${artifact.version}`
    const coordinates = { platformId: null, name: artifact.name, version: artifact.version }
    if (!TARBALL_FILE_NAME.test(artifact.file)) {
        return reportFailure({ log, qadam, reason: 'the index names a tarball outside the seed directory' })
    }
    const existing = await store.read({ coordinates })
    if (existing.status === QadamVersionReadStatus.PRESENT) {
        // The image's tarball is the same file that went to npm, so a version fetched earlier is the
        // same artifact; one that differs is kept anyway, because a version is never replaced.
        if (existing.version.integrity.origin.tarballIntegrity !== artifact.integrity) {
            log.warn({ qadam }, '[qadamVersionStore] The stored version differs from the image\'s; the stored one is kept')
        }
        return { kind: 'present' }
    }
    if (existing.status === QadamVersionReadStatus.UNSUPPORTED || existing.status === QadamVersionReadStatus.UNREADABLE) {
        log.warn({ qadam, status: existing.status, reason: existing.reason }, '[qadamVersionStore] A stored version this release cannot use is kept, not replaced by the image\'s')
        return { kind: 'kept' }
    }
    const tarballPath = path.join(seedDir, artifact.file)
    const tarballStats = await tryCatch(() => lstat(tarballPath))
    if (tarballStats.error !== null || !tarballStats.data.isFile()) {
        return reportFailure({ log, qadam, reason: 'the tarball the index names is not in the image' })
    }
    const put = await tryCatch(() => store.putTarball({
        coordinates,
        tarballPath,
        expectedIntegrity: artifact.integrity,
        origin: { kind: QadamVersionOrigin.IMAGE_SEED },
    }))
    if (put.error !== null) {
        return reportFailure({ log, qadam, reason: `could not be stored (${describeError({ error: put.error })})` })
    }
    if (put.data.status === QadamVersionPutStatus.REFUSED) {
        return reportFailure({ log, qadam, reason: put.data.reason })
    }
    return { kind: put.data.status === QadamVersionPutStatus.STORED ? 'stored' : 'present' }
}

function reportFailure({ log, qadam, reason }: { log: QadamVersionStoreLogger, qadam: string, reason: string }): SeedOutcome {
    log.warn({ qadam, reason }, '[qadamVersionStore] A version shipped in the image could not be seeded')
    return { kind: 'failed', qadam, reason }
}

function describeError({ error }: { error: unknown }): string {
    if (error instanceof Error && 'code' in error && !isNil(error.code)) {
        return String(error.code)
    }
    return error instanceof Error ? error.message : 'unknown error'
}

export type SeedReport = {
    status: SeedStatus
    reason: string | null
    stored: number
    present: number
    // Stored versions this release cannot use (UNSUPPORTED / UNREADABLE), left in place.
    kept: number
    failed: { qadam: string, reason: string }[]
}

type SeedParams = {
    store: QadamVersionStore
    seedDir: string
    log: QadamVersionStoreLogger
}

type SeedOneParams = {
    store: QadamVersionStore
    seedDir: string
    artifact: z.infer<typeof SeedArtifact>
    log: QadamVersionStoreLogger
}

type SeedOutcome =
    | { kind: 'stored' }
    | { kind: 'present' }
    | { kind: 'kept' }
    | { kind: 'failed', qadam: string, reason: string }

type SeedIndexResult =
    | { ok: true, artifacts: z.infer<typeof SeedArtifact>[] }
    | { ok: false, status: SeedStatus.NO_SEED | SeedStatus.INVALID_SEED, reason: string }
