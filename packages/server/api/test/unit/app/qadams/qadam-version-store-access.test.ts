import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockStoreOpen = vi.fn()
const mockGetOrThrow = vi.fn()

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: { getOrThrow: (...args: unknown[]) => mockGetOrThrow(...args) },
}))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        qadamVersionStore: { open: (...args: unknown[]) => mockStoreOpen(...args) },
    }
})

const log = {} as unknown as FastifyBaseLogger

beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockGetOrThrow.mockReturnValue('/store')
})

describe('qadamVersionStoreAccess.open', () => {
    it('memoizes a successful open: a later call does not open the store again', async () => {
        const { qadamVersionStoreAccess } = await import('../../../../src/app/qadams/version-store/qadam-version-store-access')
        const store = { root: '/store' }
        mockStoreOpen.mockResolvedValue({ ok: true, store })

        const first = await qadamVersionStoreAccess.open({ log })
        const second = await qadamVersionStoreAccess.open({ log })

        expect(first).toEqual({ ok: true, store })
        expect(second).toEqual({ ok: true, store })
        expect(mockStoreOpen).toHaveBeenCalledTimes(1)
    })

    it('dedupes concurrent callers onto the same in-flight open', async () => {
        const { qadamVersionStoreAccess } = await import('../../../../src/app/qadams/version-store/qadam-version-store-access')
        let resolveOpen: (value: { ok: true, store: { root: string } }) => void = () => undefined
        mockStoreOpen.mockReturnValue(new Promise((resolve) => {
            resolveOpen = resolve
        }))

        const [first, second] = [qadamVersionStoreAccess.open({ log }), qadamVersionStoreAccess.open({ log })]
        resolveOpen({ ok: true, store: { root: '/store' } })

        expect(await first).toEqual(await second)
        expect(mockStoreOpen).toHaveBeenCalledTimes(1)
    })

    it('retries on the next call after an `{ ok: false }` open, rather than caching the failure', async () => {
        const { qadamVersionStoreAccess } = await import('../../../../src/app/qadams/version-store/qadam-version-store-access')
        mockStoreOpen.mockResolvedValueOnce({ ok: false, reason: 'volume not mounted' })
        mockStoreOpen.mockResolvedValueOnce({ ok: true, store: { root: '/store' } })

        const first = await qadamVersionStoreAccess.open({ log })
        const second = await qadamVersionStoreAccess.open({ log })

        expect(first).toEqual({ ok: false, reason: 'volume not mounted' })
        expect(second).toEqual({ ok: true, store: { root: '/store' } })
        expect(mockStoreOpen).toHaveBeenCalledTimes(2)
    })

    it('retries on the next call after a rejection raised before the store open even starts (reading its own config)', async () => {
        const { qadamVersionStoreAccess } = await import('../../../../src/app/qadams/version-store/qadam-version-store-access')
        mockGetOrThrow.mockImplementationOnce(() => {
            throw new Error('QADAM_VERSION_STORE_PATH is not set')
        })
        mockStoreOpen.mockResolvedValue({ ok: true, store: { root: '/store' } })

        await expect(qadamVersionStoreAccess.open({ log })).rejects.toThrow('QADAM_VERSION_STORE_PATH is not set')
        const second = await qadamVersionStoreAccess.open({ log })

        expect(second).toEqual({ ok: true, store: { root: '/store' } })
    })
})
