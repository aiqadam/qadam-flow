import { beforeEach, describe, expect, it, vi } from 'vitest'

// Running proper-lockfile's real retry budget out takes about three minutes, so the library is
// stubbed to end in the ELOCKED it gives up with.
const lockfileStub = vi.hoisted(() => ({
    lock: vi.fn(),
}))

vi.mock('proper-lockfile', () => ({
    default: lockfileStub,
}))

beforeEach(() => {
    lockfileStub.lock.mockReset()
})

describe('fileLock.runExclusive acquisition timeout', () => {
    it('reports a lock it could not take in time as an acquisition timeout, without running the work', async () => {
        const { fileLock } = await import('../src/file-lock')
        lockfileStub.lock.mockRejectedValue(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }))
        const fn = vi.fn(async () => 'never')

        const error = await fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, log: { error: vi.fn() }, fn })
            .catch((e: unknown) => e)

        expect(fileLock.isAcquireTimeout(error)).toBe(true)
        expect(fn).not.toHaveBeenCalled()
    })

    it('does not report an ELOCKED the protected work threw as an acquisition timeout', async () => {
        const { fileLock } = await import('../src/file-lock')
        lockfileStub.lock.mockResolvedValue(async () => undefined)
        const workError = Object.assign(new Error('a nested lock was held'), { code: 'ELOCKED' })

        const error = await fileLock.runExclusive({
            path: '/tmp/file-lock-timeout-test',
            createPath: false,
            log: { error: vi.fn() },
            fn: async () => {
                throw workError
            },
        }).catch((e: unknown) => e)

        expect(error).toBe(workError)
        expect(fileLock.isAcquireTimeout(error)).toBe(false)
    })

    it('passes the caller\'s stale threshold to the lock', async () => {
        const { fileLock } = await import('../src/file-lock')
        lockfileStub.lock.mockResolvedValue(async () => undefined)

        await fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, staleMs: 60_000, log: { error: vi.fn() }, fn: async () => undefined })

        expect(lockfileStub.lock).toHaveBeenCalledWith('/tmp/file-lock-timeout-test', expect.objectContaining({ stale: 60_000 }))
    })
})
