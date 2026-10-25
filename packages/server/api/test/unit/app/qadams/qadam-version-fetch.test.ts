import { QadamVersionFetchOutcome } from '@aiqadam/server-utils'
import { ApEnvironment } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockIsPinAvailable = vi.fn()
const mockOpenStore = vi.fn()
const mockLedgerOpen = vi.fn()
const mockFetchFromRegistry = vi.fn()

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getOrThrow: vi.fn().mockReturnValue(ApEnvironment.PRODUCTION),
    },
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        isPinAvailable: (...args: unknown[]) => mockIsPinAvailable(...args),
    })),
}))

vi.mock('../../../../src/app/qadams/version-store/qadam-version-store-access', () => ({
    qadamVersionStoreAccess: {
        open: (...args: unknown[]) => mockOpenStore(...args),
    },
}))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        qadamSignatureLedger: { open: (...args: unknown[]) => mockLedgerOpen(...args) },
        qadamVersionStoreFetch: { fetchFromRegistry: (...args: unknown[]) => mockFetchFromRegistry(...args) },
    }
})

import { qadamVersionFetch } from '../../../../src/app/qadams/fetch/qadam-version-fetch'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
const STORE = { root: '/store' }

describe('qadamVersionFetch.fetchMissingPins', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockOpenStore.mockResolvedValue({ ok: true, store: STORE })
        mockLedgerOpen.mockReturnValue({})
        mockIsPinAvailable.mockResolvedValue(false)
        mockFetchFromRegistry.mockResolvedValue({ outcome: QadamVersionFetchOutcome.FETCHED, version: {} })
    })

    it('ignores a custom (non-@aiqadam/) pin: the registry for it is not built yet', async () => {
        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['my-custom-qadam@1.0.0'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockIsPinAvailable).not.toHaveBeenCalled()
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('ignores a `-main.` snapshot pin: only the checked fallback moves it', async () => {
        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@1.0.0-main.5'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('ignores a pin that is not a well-formed release version', async () => {
        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@not-a-version'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('ignores a caret/tilde range pin: ADR-0005 resolves a range from the catalogue or the store, never the registry', async () => {
        for (const pin of ['@aiqadam/qadam-csv@^0.6.0', '@aiqadam/qadam-csv@~0.6.0']) {
            mockIsPinAvailable.mockClear()
            mockFetchFromRegistry.mockClear()

            const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: [pin], platformId: undefined })

            expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
            expect(mockIsPinAvailable).not.toHaveBeenCalled()
            expect(mockFetchFromRegistry).not.toHaveBeenCalled()
        }
    })

    it('deduplicates the same name@version pin before checking availability', async () => {
        await qadamVersionFetch(log).fetchMissingPins({
            pins: ['@aiqadam/qadam-csv@0.6.0', '@aiqadam/qadam-csv@0.6.0'],
            platformId: undefined,
        })

        expect(mockIsPinAvailable).toHaveBeenCalledTimes(1)
    })

    it('fetches nothing already available in the registry, bundled image or store', async () => {
        mockIsPinAvailable.mockResolvedValue(true)

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('leaves a pin alone when its availability could not be checked, rather than fetching or hiding it', async () => {
        mockIsPinAvailable.mockRejectedValue(new Error('statement timeout'))

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('returns an empty summary and warns when the store cannot be opened', async () => {
        mockOpenStore.mockResolvedValue({ ok: false, reason: 'volume not mounted' })

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockIsPinAvailable).not.toHaveBeenCalled()
        expect(log.warn).toHaveBeenCalled()
    })

    it('caps how many missing pins one call fetches, leaving the rest for the existing fallback', async () => {
        const pins = Array.from({ length: 51 }, (_, i) => `@aiqadam/qadam-csv@0.${i}.0`)

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins, platformId: undefined })

        expect(summary).toEqual({ attempted: 50, fetched: 50, failed: 0 })
        expect(mockFetchFromRegistry).toHaveBeenCalledTimes(50)
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ attempted: 50, missing: 51 }), expect.any(String))
    })

    it('shares one deadline across every candidate in the call, not a fresh one per candidate', async () => {
        await qadamVersionFetch(log).fetchMissingPins({
            pins: ['@aiqadam/qadam-csv@0.6.0', '@aiqadam/qadam-csv@0.5.0'],
            platformId: undefined,
        })

        const deadlines = mockFetchFromRegistry.mock.calls.map((call) => call[0].deadline)
        expect(deadlines).toHaveLength(2)
        expect(deadlines[0]).toBe(deadlines[1])
    })

    it('summarizes a mix of fetched and failed outcomes across distinct missing pins', async () => {
        mockFetchFromRegistry.mockImplementation(async ({ version }: { version: string }) => version === '0.6.0'
            ? { outcome: QadamVersionFetchOutcome.FETCHED, version: {} }
            : { outcome: QadamVersionFetchOutcome.UNSIGNED, reason: 'no signature from a key this image pins verifies it' })

        const summary = await qadamVersionFetch(log).fetchMissingPins({
            pins: ['@aiqadam/qadam-csv@0.6.0', '@aiqadam/qadam-csv@0.5.0'],
            platformId: 'platform-1',
        })

        expect(summary).toEqual({ attempted: 2, fetched: 1, failed: 1 })
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ qadam: '@aiqadam/qadam-csv@0.6.0' }), expect.any(String))
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ qadam: '@aiqadam/qadam-csv@0.5.0', outcome: QadamVersionFetchOutcome.UNSIGNED }), expect.any(String))
    })
})

describe('qadamVersionFetch.fetchMissingStepPins', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockOpenStore.mockResolvedValue({ ok: true, store: STORE })
        mockLedgerOpen.mockReturnValue({})
        mockIsPinAvailable.mockResolvedValue(false)
        mockFetchFromRegistry.mockResolvedValue({ outcome: QadamVersionFetchOutcome.FETCHED, version: {} })
    })

    it('collects the distinct pins off the steps it is given and fetches each missing one', async () => {
        const steps = [
            { type: 'PIECE', name: 'step_1', settings: { qadamName: '@aiqadam/qadam-csv', qadamVersion: '0.6.0' } },
        ] as unknown as Parameters<ReturnType<typeof qadamVersionFetch>['fetchMissingStepPins']>[0]['steps']

        const summary = await qadamVersionFetch(log).fetchMissingStepPins({ steps, platformId: 'platform-1' })

        expect(summary).toEqual({ attempted: 1, fetched: 1, failed: 0 })
        expect(mockFetchFromRegistry).toHaveBeenCalledWith(expect.objectContaining({ name: '@aiqadam/qadam-csv', version: '0.6.0' }))
    })
})
