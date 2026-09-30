import { beforeEach, describe, expect, it, vi } from 'vitest'

// Running proper-lockfile's real retry budget out takes about three minutes, and a release that
// fails cannot be provoked on a real lock, so the library is stubbed.
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

describe('fileLock.runExclusive when the release fails', () => {
    it('fails with the protected work\'s own error, and logs the release failure', async () => {
        const { fileLock } = await import('../src/file-lock')
        lockfileStub.lock.mockResolvedValue(async () => {
            throw new Error('release failed')
        })
        const log = { error: vi.fn() }

        await expect(fileLock.runExclusive({
            path: '/tmp/file-lock-timeout-test',
            createPath: false,
            log,
            fn: async () => {
                throw new Error('work failed')
            },
        })).rejects.toThrow('work failed')
        expect(log.error).toHaveBeenCalledTimes(1)
        expect(log.error.mock.calls[0][1]).toContain('Could not release')
    })

    it('fails with the release error when the protected work succeeded', async () => {
        const { fileLock } = await import('../src/file-lock')
        lockfileStub.lock.mockResolvedValue(async () => {
            throw new Error('release failed')
        })

        await expect(fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, log: { error: vi.fn() }, fn: async () => 'done' }))
            .rejects.toThrow('release failed')
    })
})
