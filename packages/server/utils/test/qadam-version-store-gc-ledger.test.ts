import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamVersionStoreGcLedger } from '../src/qadam-version-store/qadam-version-store-gc-ledger'
import { QadamVersionCoordinates } from '../src/qadam-version-store/qadam-version-store-layout'

const SLACK: QadamVersionCoordinates = { platformId: null, name: '@aiqadam/qadam-slack', version: '1.2.0' }
const CUSTOM: QadamVersionCoordinates = { platformId: 'platform-a', name: 'my-custom-qadam', version: '1.0.0' }
const log = { warn: vi.fn() }

let dir: string

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-gc-ledger-')))
    log.warn.mockClear()
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('qadamVersionStoreGcLedger.reconcile', () => {
    it('starts a new entry\'s grace period at the given "now"', async () => {
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })
        const result = await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        expect(result).toEqual({ ok: true, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })

    it('keeps an already-tracked entry\'s original timestamp across runs, not the latest "now"', async () => {
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })
        await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        const second = await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-05T00:00:00.000Z' })

        expect(second).toEqual({ ok: true, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })

    it('drops an entry that is referenced again', async () => {
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })
        await ledger.reconcile({ unreferenced: [SLACK, CUSTOM], now: '2026-10-01T00:00:00.000Z' })

        const second = await ledger.reconcile({ unreferenced: [CUSTOM], now: '2026-10-05T00:00:00.000Z' })

        expect(second).toEqual({ ok: true, entries: [{ ...CUSTOM, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })

    it('survives a restart: a fresh ledger instance reads what a previous one wrote', async () => {
        await qadamVersionStoreGcLedger.open({ dir, log }).reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        const afterRestart = qadamVersionStoreGcLedger.open({ dir, log })
        const result = await afterRestart.reconcile({ unreferenced: [SLACK], now: '2026-10-05T00:00:00.000Z' })

        expect(result).toEqual({ ok: true, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })

    it('treats a corrupt ledger file as empty rather than failing, and warns', async () => {
        await writeFile(join(dir, 'qadam-gc-ledger.json'), '{ not json')
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })

        const result = await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        expect(result).toEqual({ ok: true, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
        expect(log.warn).toHaveBeenCalled()
    })

    it('treats a ledger written by a later format as empty rather than failing', async () => {
        await writeFile(join(dir, 'qadam-gc-ledger.json'), JSON.stringify({ formatVersion: 999, entries: [] }))
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })

        const result = await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        expect(result).toEqual({ ok: true, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })

    it('reconciling an empty set clears every tracked entry', async () => {
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })
        await ledger.reconcile({ unreferenced: [SLACK, CUSTOM], now: '2026-10-01T00:00:00.000Z' })

        const result = await ledger.reconcile({ unreferenced: [], now: '2026-10-05T00:00:00.000Z' })

        expect(result).toEqual({ ok: true, entries: [] })
    })

    it('writes atomically: the file on disk after a run is valid JSON matching the result', async () => {
        const ledger = qadamVersionStoreGcLedger.open({ dir, log })
        await ledger.reconcile({ unreferenced: [SLACK], now: '2026-10-01T00:00:00.000Z' })

        const onDisk = JSON.parse(await readFile(join(dir, 'qadam-gc-ledger.json'), 'utf8'))

        expect(onDisk).toEqual({ formatVersion: 1, entries: [{ ...SLACK, firstSeenUnreferencedAt: '2026-10-01T00:00:00.000Z' }] })
    })
})
