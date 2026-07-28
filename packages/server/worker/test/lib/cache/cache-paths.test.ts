import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
let originalCwd: string

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)

async function ageDirectoryAndContents(dir: string, when: Date): Promise<void> {
    await utimes(dir, when, when)
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isDirectory()) {
            await utimes(join(dir, entry.name), when, when)
        }
    }
}

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
    it('removes a stale version directory that has been idle well past the grace period, and keeps the current one', async () => {
        const { deleteStaleCache, LATEST_CACHE_VERSION } = await import('../../../src/lib/cache/cache-paths')

        const staleDir = join(tempDir, 'cache', 'v11')
        await mkdir(staleDir, { recursive: true })
        await ageDirectoryAndContents(staleDir, TEN_DAYS_AGO)
        await mkdir(join(tempDir, 'cache', LATEST_CACHE_VERSION), { recursive: true })

        await deleteStaleCache()

        const remaining = await readdir(join(tempDir, 'cache'))
        expect(remaining).toEqual([LATEST_CACHE_VERSION])
    })

    it('keeps a stale version directory that was modified recently, inside the grace period', async () => {
        const { deleteStaleCache, LATEST_CACHE_VERSION } = await import('../../../src/lib/cache/cache-paths')

        // No aging applied: mtime is "now", well inside the grace period. A
        // rolling upgrade can leave an old-version worker still writing into
        // this directory for a short window after a new-version worker starts,
        // so recent activity must not be evicted out from under it.
        await mkdir(join(tempDir, 'cache', 'v11'), { recursive: true })
        await mkdir(join(tempDir, 'cache', LATEST_CACHE_VERSION), { recursive: true })

        await deleteStaleCache()

        const remaining = await readdir(join(tempDir, 'cache'))
        expect(remaining.sort()).toEqual(['v11', LATEST_CACHE_VERSION].sort())
    })

    it('treats a version as recently active if any of its immediate subdirectories were touched recently, even though the version root itself was not', async () => {
        const { deleteStaleCache, LATEST_CACHE_VERSION } = await import('../../../src/lib/cache/cache-paths')

        const staleDir = join(tempDir, 'cache', 'v11')
        const piecesDir = join(staleDir, 'pieces-metadata')
        await mkdir(piecesDir, { recursive: true })
        // The version root's own mtime only advances when a direct child is
        // added/removed/renamed - which only happens once, at first
        // provisioning. Back-date just the root to simulate that: everything
        // that has happened since (e.g. a new piece installed under
        // pieces-metadata) shows up one level down, not on the root.
        await utimes(staleDir, TEN_DAYS_AGO, TEN_DAYS_AGO)
        await mkdir(join(tempDir, 'cache', LATEST_CACHE_VERSION), { recursive: true })

        await deleteStaleCache()

        const remaining = await readdir(join(tempDir, 'cache'))
        expect(remaining.sort()).toEqual(['v11', LATEST_CACHE_VERSION].sort())
    })

    it('resolves quietly, with no error logged, when the cache directory does not exist yet', async () => {
        const { deleteStaleCache } = await import('../../../src/lib/cache/cache-paths')
        const { logger } = await import('../../../src/lib/config/logger')

        // A freshly installed worker has no ./cache directory at all yet — that
        // is not a failure and must not be logged as one.
        await expect(deleteStaleCache()).resolves.toBeUndefined()
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('deletes every idle stale directory concurrently with force:true, so one replica racing to delete the same directory cannot abort the rest', async () => {
        const staleA = join(tempDir, 'cache', 'stale-a')
        const staleB = join(tempDir, 'cache', 'stale-b')
        await mkdir(staleA, { recursive: true })
        await mkdir(staleB, { recursive: true })
        await utimes(staleA, TEN_DAYS_AGO, TEN_DAYS_AGO)
        await utimes(staleB, TEN_DAYS_AGO, TEN_DAYS_AGO)

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
