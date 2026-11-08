import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { tryCatch } from '@aiqadam/shared'
import { z } from 'zod'
import { fileSystemUtils } from '../file-system-utils'
import { qadamVersionStoreFs } from './qadam-version-store-fs'
import { QADAM_VERSION_STORE_LAYOUT, QadamVersionCoordinates } from './qadam-version-store-layout'

// When GC (ADR-0003 "GC", ADR-0004 "Store (#478)") first saw a stored version unreferenced: nothing
// pinned it, the current image does not ship it, and no step's recent pin-move history names it as a
// revert target. A version earns its 10-day grace period from here, not from `storedAt` — a version
// pinned for a year and dropped from every flow an hour ago must still get the full grace window, not
// be collected on the next run because it is old.
//
// Kept beside the store (`QADAM_VERSION_STORE_LAYOUT.gcLedgerFile`), the same way the signature
// ledger is: not part of any version, so it adds nothing to a version's digest. A version GC ends up
// deleting drops out of the next reconcile on its own, because it is no longer among the stored
// versions offered to it — nothing has to remember to clean the entry up. One read and one parse per
// run; writes are atomic (a unique temporary file, flushed, renamed over the ledger) and replace the
// whole file, because GC itself is the only writer and always reconciles the full set in one pass
// under one lock (`distributedLock`), so there is no concurrent writer to merge against.
export const qadamVersionStoreGcLedger = {
    open: ({ dir, log }: OpenParams): QadamVersionGcLedger => createLedger({ dir, log }),
}

const MAX_LEDGER_BYTES = 16 * 1024 * 1024
const LEDGER_FORMAT_VERSION = 1

const LedgerEntry = z.object({
    platformId: z.string().nullable(),
    name: z.string(),
    version: z.string(),
    firstSeenUnreferencedAt: z.string(),
})

const LedgerFile = z.object({
    formatVersion: z.literal(LEDGER_FORMAT_VERSION),
    entries: z.array(z.unknown()),
})

const LedgerEnvelope = z.object({ formatVersion: z.number().int().positive() }).loose()

function createLedger({ dir, log }: OpenParams): QadamVersionGcLedger {
    const filePath = path.join(dir, QADAM_VERSION_STORE_LAYOUT.gcLedgerFile)

    const reconcile = async ({ unreferenced, now }: { unreferenced: QadamVersionCoordinates[], now: string }): Promise<ReconcileResult> => {
        const current = await readLedger({ filePath, log })
        const byKey = new Map(current.map((entry) => [tripleKey(entry), entry]))
        const entries = unreferenced.map((coordinates): QadamVersionGcLedgerEntry => {
            const existing = byKey.get(tripleKey(coordinates))
            return {
                platformId: coordinates.platformId,
                name: coordinates.name,
                version: coordinates.version,
                firstSeenUnreferencedAt: existing?.firstSeenUnreferencedAt ?? now,
            }
        })
        const written = await tryCatch(() => writeLedger({ dir, filePath, entries }))
        if (written.error !== null) {
            return { ok: false, reason: `the GC ledger cannot be written (${qadamVersionStoreFs.describeErrorCode({ error: written.error })})` }
        }
        return { ok: true, entries }
    }

    return { filePath, reconcile }
}

// A JSON array, not a string join: no platform id, name or version can be spelled so that two
// different triples share a key.
function tripleKey({ platformId, name, version }: { platformId: string | null, name: string, version: string }): string {
    return JSON.stringify([platformId, name, version])
}

async function readLedger({ filePath, log }: { filePath: string, log: QadamVersionGcLedgerLogger }): Promise<QadamVersionGcLedgerEntry[]> {
    const stats = await tryCatch(() => lstat(filePath))
    if (stats.error !== null) {
        if (fileSystemUtils.hasErrorCode({ error: stats.error, code: 'ENOENT' })) {
            return []
        }
        log.warn({ reason: qadamVersionStoreFs.describeErrorCode({ error: stats.error }) }, '[qadamVersionStoreGcLedger] The GC ledger cannot be read; every stored version starts its grace period over')
        return []
    }
    if (!stats.data.isFile() || stats.data.size > MAX_LEDGER_BYTES) {
        log.warn({}, '[qadamVersionStoreGcLedger] The GC ledger is not a regular file of a sane size; every stored version starts its grace period over')
        return []
    }
    const content = await tryCatch(() => readFile(filePath, 'utf8'))
    if (content.error !== null) {
        log.warn({ reason: qadamVersionStoreFs.describeErrorCode({ error: content.error }) }, '[qadamVersionStoreGcLedger] The GC ledger cannot be read; every stored version starts its grace period over')
        return []
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(content.data))
    if (parsed.error !== null) {
        log.warn({}, '[qadamVersionStoreGcLedger] The GC ledger is not valid JSON; every stored version starts its grace period over')
        return []
    }
    const envelope = LedgerEnvelope.safeParse(parsed.data)
    if (!envelope.success || envelope.data.formatVersion > LEDGER_FORMAT_VERSION) {
        log.warn({}, '[qadamVersionStoreGcLedger] The GC ledger is not a format this release reads; every stored version starts its grace period over')
        return []
    }
    const file = LedgerFile.safeParse(parsed.data)
    if (!file.success) {
        log.warn({}, '[qadamVersionStoreGcLedger] The GC ledger is not a GC ledger; every stored version starts its grace period over')
        return []
    }
    // One bad record is dropped, not the whole file.
    return file.data.entries.flatMap((raw) => {
        const entry = LedgerEntry.safeParse(raw)
        return entry.success ? [entry.data] : []
    })
}

// A unique temporary name, so two replicas never write the same file; the rename is the commit.
async function writeLedger({ dir, filePath, entries }: { dir: string, filePath: string, entries: QadamVersionGcLedgerEntry[] }): Promise<void> {
    const temporary = path.join(dir, `.${QADAM_VERSION_STORE_LAYOUT.gcLedgerFile}.${randomUUID()}.tmp`)
    const written = await tryCatch(async () => {
        const handle = await open(temporary, 'wx', 0o644)
        try {
            await handle.writeFile(JSON.stringify({ formatVersion: LEDGER_FORMAT_VERSION, entries }) + '\n')
            await handle.datasync()
        }
        finally {
            await handle.close()
        }
        await rename(temporary, filePath)
    })
    if (written.error !== null) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw written.error
    }
    await syncDirectory({ dir })
}

// Best effort: the rename is already visible; this makes it survive a power cut.
async function syncDirectory({ dir }: { dir: string }): Promise<void> {
    const handle = await tryCatch(() => open(dir, 'r'))
    if (handle.error !== null) {
        return
    }
    await handle.data.datasync().catch(() => undefined)
    await handle.data.close().catch(() => undefined)
}

export type QadamVersionGcLedgerEntry = {
    platformId: string | null
    name: string
    version: string
    firstSeenUnreferencedAt: string
}

export type QadamVersionGcLedgerLogger = {
    warn: (obj: Record<string, unknown>, msg: string) => void
}

type ReconcileResult =
    | { ok: true, entries: QadamVersionGcLedgerEntry[] }
    | { ok: false, reason: string }

export type QadamVersionGcLedger = {
    filePath: string
    // Replaces the ledger with exactly these coordinates: a coordinate not already tracked starts its
    // grace period at `now`; one no longer offered (referenced again, or already removed) is dropped.
    // The whole set is passed every run, because GC is the only writer and reconciles the full store
    // in one pass under one lock, so there is nothing to merge against.
    reconcile: (params: { unreferenced: QadamVersionCoordinates[], now: string }) => Promise<ReconcileResult>
}

type OpenParams = {
    dir: string
    log: QadamVersionGcLedgerLogger
}
