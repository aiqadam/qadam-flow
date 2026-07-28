import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
let originalCwd: string

beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await mkdtemp(join(tmpdir(), 'cache-paths-test-'))
    process.chdir(tempDir)
    vi.resetModules()
    // The real logger pulls in @aiqadam/shared's formula module, which fails to
    // resolve in this suite for unrelated, pre-existing reasons (see #215).
    // Mock it out so these tests exercise deleteStaleCache's own logic only.
    vi.doMock('../../../src/lib/config/logger', () => ({
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    }))
})

afterEach(async () => {
    process.chdir(originalCwd)
    vi.doUnmock('fs/promises')
    await rm(tempDir, { recursive: true, force: true })
})

describe('deleteStaleCache', () => {
    it('removes every stale version directory and keeps the current one', async () => {
        const { deleteStaleCache, LATEST_CACHE_VERSION } = await import('../../../src/lib/cache/cache-paths')

        await mkdir(join(tempDir, 'cache', 'v11'), { recursive: true })
        await mkdir(join(tempDir, 'cache', LATEST_CACHE_VERSION), { recursive: true })

        await deleteStaleCache()

        const remaining = await readdir(join(tempDir, 'cache'))
        expect(remaining).toEqual([LATEST_CACHE_VERSION])
    })

    it('resolves quietly, with no error logged, when the cache directory does not exist yet', async () => {
        const { deleteStaleCache } = await import('../../../src/lib/cache/cache-paths')
        const { logger } = await import('../../../src/lib/config/logger')

        // A freshly installed worker has no ./cache directory at all yet — that
        // is not a failure and must not be logged as one.
        await expect(deleteStaleCache()).resolves.toBeUndefined()
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('deletes every stale directory concurrently with force:true, so one replica racing to delete the same directory cannot abort the rest', async () => {
        await mkdir(join(tempDir, 'cache', 'stale-a'), { recursive: true })
        await mkdir(join(tempDir, 'cache', 'stale-b'), { recursive: true })

        const rmCalls: unknown[][] = []
        vi.doMock('fs/promises', async () => {
            const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
            return {
                ...actual,
                rm: vi.fn(async (...args: unknown[]) => {
                    rmCalls.push(args)
                    return actual.rm(...(args as Parameters<typeof actual.rm>))
                }),
            }
        })

        const { deleteStaleCache, LATEST_CACHE_VERSION } = await import('../../../src/lib/cache/cache-paths')
        await mkdir(join(tempDir, 'cache', LATEST_CACHE_VERSION), { recursive: true })

        await deleteStaleCache()

        // Two independent stale directories -> two independent rm() calls, each
        // tolerant of the target already having disappeared underneath it
        // (force:true), rather than one sequential loop that stops on the first
        // ENOENT and leaves the rest of the stale directories behind.
        expect(rmCalls).toHaveLength(2)
        for (const [, opts] of rmCalls) {
            expect(opts).toMatchObject({ recursive: true, force: true })
        }
    })
})
