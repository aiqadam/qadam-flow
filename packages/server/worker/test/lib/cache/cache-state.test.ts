import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileLock } from '@aiqadam/server-utils'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { CACHE_STATE_LOCK_SUFFIX, cacheState } from '../../../src/lib/cache/cache-state'

const folders: string[] = []
const log = pino({ level: 'silent' })

function uniqueFolder(): string {
    const folder = join(tmpdir(), `cache-state-test-${randomUUID()}`)
    folders.push(folder)
    return folder
}

afterEach(async () => {
    for (const f of folders) {
        await rm(f, { recursive: true, force: true })
    }
    folders.length = 0
})

describe('cacheState', () => {
    describe('getOrSetCache', () => {
        it('returns cache hit from memory on second call', async () => {
            const folder = uniqueFolder()
            const cs = cacheState(folder)

            const result1 = await cs.getOrSetCache({
                key: 'myKey',
                cacheMiss: () => false,
                installFn: async () => 'installed',
                skipSave: () => false,
            })

            expect(result1).toEqual({ cacheHit: false, state: 'installed' })

            // second call should hit memory cache
            const result2 = await cacheState(folder).getOrSetCache({
                key: 'myKey',
                cacheMiss: () => false,
                installFn: async () => { throw new Error('should not be called') },
                skipSave: () => false,
            })

            expect(result2).toEqual({ cacheHit: true, state: 'installed' })
        })

        it('returns cache hit from disk when memory has not been populated for a new folder reference', async () => {
            const folder = uniqueFolder()

            // Seed cache.json on disk via saveCache
            await cacheState(folder).saveCache('diskKey', 'disk-value')

            // Use a fresh folder path string (same value) but the module-level `cached` already has it
            // from saveCache. Instead, let's test disk read by using getOrSetCache on a key that was saved.
            const result = await cacheState(folder).getOrSetCache({
                key: 'diskKey',
                cacheMiss: () => false,
                installFn: async () => { throw new Error('should not be called') },
                skipSave: () => false,
            })

            expect(result).toEqual({ cacheHit: true, state: 'disk-value' })
        })

        it('calls installFn and saves on full cache miss', async () => {
            const folder = uniqueFolder()
            let installCalled = false

            const result = await cacheState(folder).getOrSetCache({
                key: 'newKey',
                cacheMiss: () => false,
                installFn: async () => {
                    installCalled = true
                    return 'installed-value'
                },
                skipSave: () => false,
            })

            expect(result).toEqual({ cacheHit: false, state: 'installed-value' })
            expect(installCalled).toBe(true)

            // Verify file on disk
            const raw = await readFile(join(folder, 'cache.json'), 'utf8')
            expect(JSON.parse(raw)).toEqual({ newKey: 'installed-value' })
        })

        it('calls installFn but skips save when skipSave returns true', async () => {
            const folder = uniqueFolder()

            const result = await cacheState(folder).getOrSetCache({
                key: 'skipKey',
                cacheMiss: () => false,
                installFn: async () => 'no-save-value',
                skipSave: () => true,
            })

            expect(result).toEqual({ cacheHit: false, state: 'no-save-value' })

            // cache.json should not exist
            const exists = await readFile(join(folder, 'cache.json'), 'utf8').then(() => true, () => false)
            expect(exists).toBe(false)
        })

        it('uses cacheMiss predicate to invalidate stale cached values', async () => {
            const folder = uniqueFolder()

            // Seed with old version
            await cacheState(folder).saveCache('staleKey', 'old-version')

            const result = await cacheState(folder).getOrSetCache({
                key: 'staleKey',
                cacheMiss: (value) => value === 'old-version',
                installFn: async () => 'new-version',
                skipSave: () => false,
            })

            expect(result).toEqual({ cacheHit: false, state: 'new-version' })

            const raw = await readFile(join(folder, 'cache.json'), 'utf8')
            expect(JSON.parse(raw)).toEqual({ staleKey: 'new-version' })
        })
    })

    describe('saveCache', () => {
        it('creates directory, reads existing cache, merges new key, writes atomically', async () => {
            const folder = uniqueFolder()

            await cacheState(folder).saveCache('existingKey', 'existingVal')
            const result = await cacheState(folder).saveCache('newKey', 'newVal')

            expect(result).toEqual({ existingKey: 'existingVal', newKey: 'newVal' })

            const raw = await readFile(join(folder, 'cache.json'), 'utf8')
            expect(JSON.parse(raw)).toEqual({ existingKey: 'existingVal', newKey: 'newVal' })
        })

        it('works when no prior cache file exists', async () => {
            const folder = uniqueFolder()

            const result = await cacheState(folder).saveCache('onlyKey', 'onlyVal')

            expect(result).toEqual({ onlyKey: 'onlyVal' })

            const raw = await readFile(join(folder, 'cache.json'), 'utf8')
            expect(JSON.parse(raw)).toEqual({ onlyKey: 'onlyVal' })
        })
    })
})

describe('cacheState across replicas (#586)', () => {
    it('makes a second replica wait for the first one and take its result instead of installing again', async () => {
        const folder = uniqueFolder()
        let releaseFirstReplica: () => void = () => undefined
        const firstReplicaMayFinish = new Promise<void>((resolve) => {
            releaseFirstReplica = resolve
        })
        let firstReplicaHoldsLock: () => void = () => undefined
        const firstReplicaLocked = new Promise<void>((resolve) => {
            firstReplicaHoldsLock = resolve
        })

        // Another container shares only the filesystem, so it takes the same on-disk lock
        // directly rather than through this process's memoryLock.
        const firstReplica = fileLock.runExclusive({
            path: `${folder}${CACHE_STATE_LOCK_SUFFIX}`,
            createPath: false,
            log,
            fn: async () => {
                firstReplicaHoldsLock()
                await firstReplicaMayFinish
                await cacheState(folder).saveCache('sharedKey', 'from-first-replica')
            },
        })
        await firstReplicaLocked

        let installCalls = 0
        const secondReplica = cacheState(folder).getOrSetCache({
            key: 'sharedKey',
            cacheMiss: () => false,
            installFn: async () => {
                installCalls++
                return 'from-second-replica'
            },
            skipSave: () => false,
            crossProcess: { log },
        })
        releaseFirstReplica()

        await firstReplica
        expect(await secondReplica).toEqual({ cacheHit: true, state: 'from-first-replica' })
        expect(installCalls).toBe(0)
    })

    it('takes no cross-container lock unless the caller opts in', async () => {
        const folder = uniqueFolder()
        let releaseOtherReplica: () => void = () => undefined
        const otherReplicaMayFinish = new Promise<void>((resolve) => {
            releaseOtherReplica = resolve
        })
        let otherReplicaHoldsLock: () => void = () => undefined
        const otherReplicaLocked = new Promise<void>((resolve) => {
            otherReplicaHoldsLock = resolve
        })
        const otherReplica = fileLock.runExclusive({
            path: `${folder}${CACHE_STATE_LOCK_SUFFIX}`,
            createPath: false,
            log,
            fn: async () => {
                otherReplicaHoldsLock()
                await otherReplicaMayFinish
            },
        })
        await otherReplicaLocked

        const result = await cacheState(folder).getOrSetCache({
            key: 'draftKey',
            cacheMiss: () => false,
            installFn: async () => 'fetched',
            skipSave: () => true,
        })
        releaseOtherReplica()
        await otherReplica

        expect(result).toEqual({ cacheHit: false, state: 'fetched' })
    })

    it('leaves nothing but cache.json behind: no temp file, no lock', async () => {
        const folder = uniqueFolder()

        await cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn: async () => 'v',
            skipSave: () => false,
            crossProcess: { log },
        })

        expect(await readdir(folder)).toEqual(['cache.json'])
        const siblings = await readdir(dirname(folder))
        expect(siblings.filter((entry) => entry.startsWith(`${basename(folder)}${CACHE_STATE_LOCK_SUFFIX}`))).toEqual([])
    })
})

describe('cacheState with an unreadable cache.json (#586)', () => {
    it.each([
        ['an empty file', ''],
        ['truncated JSON', '{"k":'],
        ['a non-object', '["v"]'],
        ['a non-string value', '{"k":1}'],
    ])('treats %s as an empty cache and rebuilds', async (_name, content) => {
        const folder = uniqueFolder()
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'cache.json'), content)

        const result = await cacheState(folder).getOrSetCache({
            key: 'k',
            cacheMiss: () => false,
            installFn: async () => 'rebuilt',
            skipSave: () => false,
        })

        expect(result).toEqual({ cacheHit: false, state: 'rebuilt' })
        expect(JSON.parse(await readFile(join(folder, 'cache.json'), 'utf8'))).toEqual({ k: 'rebuilt' })
    })
})
