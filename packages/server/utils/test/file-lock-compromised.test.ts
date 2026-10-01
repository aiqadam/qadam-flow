import { describe, expect, it, vi } from 'vitest'
// Imported statically rather than inside each test so that loading the module, which drags in
// the whole @aiqadam/shared source barrel, happens at collection: inside a test it took over 5s on
// a loaded CI runner and timed out whichever test paid for it first (same cause as #183). vi.mock
// is hoisted above this import, so the stub still applies.
import { fileLock } from '../src/file-lock'

// proper-lockfile only reports a compromise from its mtime-refresh timer, minutes after the lock
// was taken, so the library is stubbed to report one straight away.
vi.mock('proper-lockfile', () => ({
    default: {
        lock: async (_path: string, options: { onCompromised: (error: Error) => void }) => {
            options.onCompromised(Object.assign(new Error('Unable to update lock within the stale threshold'), { code: 'ECOMPROMISED' }))
            return async () => {
                throw Object.assign(new Error('Lock is already released'), { code: 'ERELEASED' })
            }
        },
    },
}))

describe('fileLock.runExclusive when the lock is compromised while held', () => {
    it('logs the compromise, lets the protected work finish, and does not fail on the release', async () => {
        const log = { error: vi.fn() }

        const result = await fileLock.runExclusive({
            path: '/tmp/file-lock-compromised-test',
            createPath: false,
            log,
            fn: async () => 'finished',
        })

        expect(result).toBe('finished')
        expect(log.error).toHaveBeenCalledTimes(1)
        expect(log.error.mock.calls[0][1]).toContain('compromised')
    })
})
