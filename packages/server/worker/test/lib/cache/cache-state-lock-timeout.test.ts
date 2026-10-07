import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Waiting out proper-lockfile's real retry budget takes minutes, so the lock is stubbed to
// report the timeout it ends in.
const lockStub = vi.hoisted(() => ({
    timeoutOn: (path: string): Error => Object.assign(new Error(`Timed out waiting for the file lock on ${path}`), { lockPath: path }),
    timesOut: true,
}))

vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        fileLock: {
            runExclusive: async <T>({ path, fn }: { path: string, fn: (lock: { isCompromised: () => boolean }) => Promise<T> }): Promise<T> => {
                if (lockStub.timesOut) {
                    throw lockStub.timeoutOn(path)
                }
                return fn({ isCompromised: () => false })
            },
            isAcquireTimeout: ({ error, path }: { error: unknown, path: string }): boolean =>
                error instanceof Error && 'lockPath' in error && error.lockPath === path,
        },
    }
})

const folders: string[] = []

afterEach(async () => {
    lockStub.timesOut = true
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })))
    folders.length = 0
})

// The first test's dynamic import of `cache-state` loads the real @aiqadam/server-utils graph in
// through the `importOriginal` mock — module load, not I/O, so its cost is charged to the test. On
// CI that load runs ~4 s (4333 ms on main) and tips past vitest's 5000 ms default when the runner is
// loaded. A generous explicit timeout keeps the suite off the line. See #760.
describe('cacheState when the cross-container lock times out (#586)', { timeout: 15_000 }, () => {
    it('installs without the lock instead of failing the job, and saves the result', async () => {
        const { cacheState } = await import('../../../src/lib/cache/cache-state')
        const folder = join(tmpdir(), `cache-state-timeout-${randomUUID()}`)
        folders.push(folder)
        const log = pino({ level: 'silent' })
        const warn = vi.spyOn(log, 'warn')

        const result = await cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn: async () => 'built-alongside',
            skipSave: () => false,
            crossProcess: { log },
        })

        expect(result).toEqual({ cacheHit: false, state: 'built-alongside' })
        expect(JSON.parse(await readFile(join(folder, 'cache.json'), 'utf8'))).toEqual({ k: 'built-alongside' })
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('takes the other replica\'s result when it landed on disk while this one waited', async () => {
        const { cacheState } = await import('../../../src/lib/cache/cache-state')
        const folder = join(tmpdir(), `cache-state-timeout-${randomUUID()}`)
        folders.push(folder)
        const installFn = vi.fn(async () => 'should-not-build')

        // Primes this process's memory with the miss, as it would be before the wait began.
        await cacheState(folder).getOrSetCache({
            key: 'other',
            cacheMiss: () => false,
            installFn: async () => 'unrelated',
            skipSave: () => false,
        })
        await cacheState(folder).saveCache('k', 'from-other-replica')

        const result = await cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn,
            skipSave: () => false,
            crossProcess: { log: pino({ level: 'silent' }) },
        })

        expect(result).toEqual({ cacheHit: true, state: 'from-other-replica' })
        expect(installFn).not.toHaveBeenCalled()
    })

    it('fails, without installing a second time unlocked, when the install itself fails under the lock', async () => {
        const { cacheState } = await import('../../../src/lib/cache/cache-state')
        const folder = join(tmpdir(), `cache-state-timeout-${randomUUID()}`)
        folders.push(folder)
        lockStub.timesOut = false
        const installFn = vi.fn(async (): Promise<string> => {
            throw Object.assign(new Error('a nested lock was held'), { code: 'ELOCKED' })
        })

        await expect(cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn,
            skipSave: () => false,
            crossProcess: { log: pino({ level: 'silent' }) },
        })).rejects.toThrow('a nested lock was held')
        expect(installFn).toHaveBeenCalledTimes(1)
    })

    it('fails, without installing a second time unlocked, when the install times out on a lock of its own', async () => {
        const { cacheState } = await import('../../../src/lib/cache/cache-state')
        const folder = join(tmpdir(), `cache-state-timeout-${randomUUID()}`)
        folders.push(folder)
        lockStub.timesOut = false
        const installFn = vi.fn(async (): Promise<string> => {
            throw lockStub.timeoutOn(join(folder, 'workspace'))
        })

        await expect(cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn,
            skipSave: () => false,
            crossProcess: { log: pino({ level: 'silent' }) },
        })).rejects.toThrow('Timed out waiting for the file lock on')
        expect(installFn).toHaveBeenCalledTimes(1)
    })
})
