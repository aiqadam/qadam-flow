import { beforeEach, describe, expect, it, vi } from 'vitest'
// Imported statically rather than inside each test so that loading the module, which drags in
// the whole @aiqadam/shared source barrel, happens at collection: inside a test it took over 5s on
// a loaded CI runner and timed out whichever test paid for it first (same cause as #183). vi.mock
// is hoisted above this import, so the stub still applies.
import { fileLock } from '../src/file-lock'

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
        lockfileStub.lock.mockRejectedValue(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }))
        const fn = vi.fn(async () => 'never')

        const error = await fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, log: { error: vi.fn() }, fn })
            .catch((e: unknown) => e)

        expect(fileLock.isAcquireTimeout({ error, path: '/tmp/file-lock-timeout-test' })).toBe(true)
        expect(fn).not.toHaveBeenCalled()
    })

    it('does not report a timeout on another lock as a timeout on this one', async () => {
        lockfileStub.lock.mockRejectedValue(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }))

        const error = await fileLock.runExclusive({ path: '/tmp/file-lock-inner-lock', createPath: false, log: { error: vi.fn() }, fn: async () => undefined })
            .catch((e: unknown) => e)

        expect(fileLock.isAcquireTimeout({ error, path: '/tmp/file-lock-inner-lock' })).toBe(true)
        expect(fileLock.isAcquireTimeout({ error, path: '/tmp/file-lock-timeout-test' })).toBe(false)
    })

    it('tells the protected work when the lock has been compromised', async () => {
        let reportCompromise: (error: Error) => void = () => undefined
        lockfileStub.lock.mockImplementation(async (_path: string, options: { onCompromised: (error: Error) => void }) => {
            reportCompromise = options.onCompromised
            return async () => undefined
        })

        const seen = await fileLock.runExclusive({
            path: '/tmp/file-lock-timeout-test',
            createPath: false,
            log: { error: vi.fn() },
            fn: async ({ isCompromised }) => {
                const before = isCompromised()
                reportCompromise(new Error('Unable to update lock within the stale threshold'))
                return { before, after: isCompromised() }
            },
        })

        expect(seen).toEqual({ before: false, after: true })
    })

    it('does not report an ELOCKED the protected work threw as an acquisition timeout', async () => {
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
        expect(fileLock.isAcquireTimeout({ error, path: '/tmp/file-lock-timeout-test' })).toBe(false)
    })

    it('passes the caller\'s stale threshold to the lock', async () => {
        lockfileStub.lock.mockResolvedValue(async () => undefined)

        await fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, staleMs: 60_000, log: { error: vi.fn() }, fn: async () => undefined })

        expect(lockfileStub.lock).toHaveBeenCalledWith('/tmp/file-lock-timeout-test', expect.objectContaining({ stale: 60_000 }))
    })
})

describe('fileLock.runExclusive when the release fails', () => {
    it('fails with the protected work\'s own error, and logs the release failure', async () => {
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
        lockfileStub.lock.mockResolvedValue(async () => {
            throw new Error('release failed')
        })

        await expect(fileLock.runExclusive({ path: '/tmp/file-lock-timeout-test', createPath: false, log: { error: vi.fn() }, fn: async () => 'done' }))
            .rejects.toThrow('release failed')
    })
})
