import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Waiting out proper-lockfile's real retry budget takes minutes, so the lock is stubbed to
// report the timeout it ends in.
vi.mock('@aiqadam/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/server-utils')>()
    return {
        ...actual,
        fileLock: {
            runExclusive: async () => {
                throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
            },
        },
    }
})

const folders: string[] = []

afterEach(async () => {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })))
    folders.length = 0
})

describe('cacheState when the cross-container lock times out (#586)', () => {
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
})
