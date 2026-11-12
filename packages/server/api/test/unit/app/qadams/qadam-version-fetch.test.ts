import { QadamVersionFetchOutcome } from '@aiqadam/server-utils'
import { ApEnvironment } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

const mockIsPinAvailable = vi.fn()
const mockOpenStore = vi.fn()
const mockLedgerOpen = vi.fn()
const mockFetchFromRegistry = vi.fn()
const mockGetBoolean = vi.fn()
const mockRegistryGet = vi.fn()

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getOrThrow: vi.fn().mockReturnValue(ApEnvironment.PRODUCTION),
        getBoolean: (...args: unknown[]) => mockGetBoolean(...args),
    },
}))

vi.mock('../../../../src/app/qadams/version-store/qadam-registry-config', () => ({
    qadamRegistryConfig: {
        get: (...args: unknown[]) => mockRegistryGet(...args),
        isDefault: ({ url }: { url: string }) => url.trim().replace(/\/+$/, '').toLowerCase() === DEFAULT_REGISTRY_URL,
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
        mockGetBoolean.mockReturnValue(false)
        mockRegistryGet.mockReturnValue({ url: DEFAULT_REGISTRY_URL, token: null })
    })

    it('ignores a custom (non-@aiqadam/) pin when no platformId is given: nothing to namespace it under', async () => {
        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['my-custom-qadam@1.0.0'], platformId: undefined })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockIsPinAvailable).not.toHaveBeenCalled()
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('ignores a custom (non-@aiqadam/) pin when the registry is still the default npmjs: ADR-0005 §2 forbids asking npmjs for a custom name', async () => {
        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['my-custom-qadam@1.0.0'], platformId: 'platform-1' })

        expect(summary).toEqual({ attempted: 0, fetched: 0, failed: 0 })
        expect(mockIsPinAvailable).not.toHaveBeenCalled()
        expect(mockFetchFromRegistry).not.toHaveBeenCalled()
    })

    it('fetches a custom pin from the configured registry once a platformId and a non-default registry are both present', async () => {
        mockRegistryGet.mockReturnValue({ url: 'https://npm.example.internal', token: 'secret-token' })

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: ['my-custom-qadam@1.0.0'], platformId: 'platform-1' })

        expect(summary).toEqual({ attempted: 1, fetched: 1, failed: 0 })
        expect(mockIsPinAvailable).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-custom-qadam', version: '1.0.0', platformId: 'platform-1' }))
        expect(mockFetchFromRegistry).toHaveBeenCalledWith(expect.objectContaining({
            name: 'my-custom-qadam',
            version: '1.0.0',
            registryUrl: 'https://npm.example.internal',
            registryToken: 'secret-token',
            platformId: 'platform-1',
            requireSignature: false,
        }))
    })

    it('requires a verified signature for a custom pin when the custom signature check setting is on', async () => {
        mockRegistryGet.mockReturnValue({ url: 'https://npm.example.internal', token: null })
        mockGetBoolean.mockReturnValue(true)

        await qadamVersionFetch(log).fetchMissingPins({ pins: ['my-custom-qadam@1.0.0'], platformId: 'platform-1' })

        expect(mockFetchFromRegistry).toHaveBeenCalledWith(expect.objectContaining({ requireSignature: true }))
    })

    it('never sends a custom registry URL, token or requireSignature for an official pin', async () => {
        mockRegistryGet.mockReturnValue({ url: 'https://npm.example.internal', token: 'secret-token' })
        mockGetBoolean.mockReturnValue(true)

        await qadamVersionFetch(log).fetchMissingPins({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: 'platform-1' })

        const call = mockFetchFromRegistry.mock.calls[0][0]
        expect(call).not.toHaveProperty('registryUrl')
        expect(call).not.toHaveProperty('registryToken')
        expect(call).not.toHaveProperty('requireSignature')
    })

    it('ignores an official-scoped name that is not itself a well-formed npm package name', async () => {
        const tooLong = `@aiqadam/${'a'.repeat(300)}`

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins: [`${tooLong}@1.0.0`], platformId: undefined })

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

    it('caps how many candidates one call even checks, before the expensive per-candidate availability lookup', async () => {
        const pins = Array.from({ length: 51 }, (_, i) => `@aiqadam/qadam-csv@0.${i}.0`)

        const summary = await qadamVersionFetch(log).fetchMissingPins({ pins, platformId: undefined })

        expect(summary).toEqual({ attempted: 50, fetched: 50, failed: 0 })
        expect(mockIsPinAvailable).toHaveBeenCalledTimes(50)
        expect(mockFetchFromRegistry).toHaveBeenCalledTimes(50)
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ candidates: 50, total: 51 }), expect.any(String))
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
        mockGetBoolean.mockReturnValue(false)
        mockRegistryGet.mockReturnValue({ url: DEFAULT_REGISTRY_URL, token: null })
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
