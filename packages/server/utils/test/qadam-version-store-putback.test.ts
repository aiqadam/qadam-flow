import { renameSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { cp, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QadamVersionOrigin, QadamVersionPutStatus, qadamVersionStore, QadamVersionStore } from '../src/qadam-version-store/qadam-version-store'
import { qadamVersionStoreLayout } from '../src/qadam-version-store/qadam-version-store-layout'
import { tarFixtures } from './qadam-version-store-fixtures'

// Lets a test fail one `rename` the store makes: the put-back of a version it moved aside.
const renameFailure: { fromTrash: NodeJS.ErrnoException | null } = { fromTrash: null }

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof fsPromises>()
    return {
        ...actual,
        rename: async (from: string, to: string): Promise<void> => {
            if (renameFailure.fromTrash !== null && from.includes('/.trash/')) {
                throw renameFailure.fromTrash
            }
            return actual.rename(from, to)
        },
    }
})

const CSV = { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0' }
const log = { info: vi.fn(), warn: vi.fn() }

let tempDir: string
let root: string
let store: QadamVersionStore

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-putback-')))
    root = join(tempDir, 'store')
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    store = opened.store
    renameFailure.fromTrash = null
    log.warn.mockReset()
})

afterEach(async () => {
    renameFailure.fromTrash = null
    await rm(tempDir, { recursive: true, force: true })
})

describe('putting back a version another writer stored', () => {
    it('leaves it in .trash for the leftover cleanup when it cannot be put back, instead of deleting it', async () => {
        const versionDir = qadamVersionStoreLayout.versionDir({ root, coordinates: CSV })
        await put({ extra: {} })
        const otherWriters = join(tempDir, 'other-writers-copy')
        await cp(versionDir, otherWriters, { recursive: true })
        const otherRecord = await readFile(join(otherWriters, 'integrity.json'), 'utf8')
        await unlink(join(versionDir, 'integrity.json'))
        log.warn.mockImplementation((_obj: unknown, msg: string) => {
            if (msg.includes('Replacing a damaged version') && renameFailure.fromTrash === null) {
                renameSync(versionDir, join(tempDir, 'damaged-moved-by-the-other-writer'))
                renameSync(otherWriters, versionDir)
                renameFailure.fromTrash = Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
            }
        })

        await put({ extra: { 'src/new.js': 'x' } })

        const trash = await readdir(join(root, '.trash'))
        expect(trash).toHaveLength(1)
        expect(await readFile(join(root, '.trash', trash[0], 'integrity.json'), 'utf8')).toBe(otherRecord)
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'EIO' }), expect.stringContaining('stays in .trash'))
    })
})

async function put({ extra }: { extra: Record<string, string> }): Promise<QadamVersionPutStatus> {
    const data = tarFixtures.tarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, extra }) }) })
    const path = join(tempDir, `fixture-${Math.random().toString(36).slice(2)}.tgz`)
    await writeFile(path, data)
    const result = await store.putTarball({ coordinates: CSV, tarballPath: path, expectedIntegrity: tarFixtures.integrity({ data }), origin: { kind: QadamVersionOrigin.REGISTRY } })
    return result.status
}
