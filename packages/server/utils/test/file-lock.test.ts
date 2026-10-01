import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileLock } from '../src/file-lock'

let tempDir: string
const log = { error: vi.fn() }

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'file-lock-test-')))
})

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
})

describe('fileLock.runExclusive', () => {
    it('creates the locked directory by default', async () => {
        const resource = join(tempDir, 'resource')

        await fileLock.runExclusive({ path: resource, log, fn: async () => undefined })

        expect(await readdir(tempDir)).toEqual(['resource'])
    })

    it('with createPath: false, locks a name without creating it, and removes the lock afterwards', async () => {
        const lockName = join(tempDir, 'lock-name')

        const entriesWhileLocked = await fileLock.runExclusive({
            path: lockName,
            log,
            createPath: false,
            fn: () => readdir(tempDir),
        })

        expect(entriesWhileLocked).toEqual(['lock-name.lock'])
        expect(await readdir(tempDir)).toEqual([])
    })

    it('serializes holders of the same lock', async () => {
        const lockName = join(tempDir, randomUUID())
        const events: string[] = []

        const hold = (name: string) => fileLock.runExclusive({
            path: lockName,
            log,
            createPath: false,
            fn: async () => {
                events.push(`${name}:start`)
                await new Promise((resolve) => setTimeout(resolve, 50))
                events.push(`${name}:end`)
            },
        })
        await Promise.all([hold('a'), hold('b')])

        expect([
            ['a:start', 'a:end', 'b:start', 'b:end'],
            ['b:start', 'b:end', 'a:start', 'a:end'],
        ]).toContainEqual(events)
    })

    it('holds a named lock and the default lock of a sibling directory at the same time and releases both', async () => {
        const resource = join(tempDir, 'common')

        const inner = await fileLock.runExclusive({
            path: resource,
            log,
            fn: () => fileLock.runExclusive({
                path: `${resource}.cache-state`,
                log,
                createPath: false,
                fn: async () => 'acquired',
            }),
        })

        expect(inner).toBe('acquired')
        expect(await readdir(tempDir)).toEqual(['common'])
    })
})
