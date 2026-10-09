import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QadamVersionOrigin, QadamVersionReadStatus, qadamVersionStore, QadamVersionStore } from '../src/qadam-version-store/qadam-version-store'
import { qadamVersionStoreSeed, SeedStatus } from '../src/qadam-version-store/qadam-version-store-seed'
import { tarFixtures } from './qadam-version-store-fixtures'

const CSV = { name: '@aiqadam/qadam-csv', version: '0.6.0' }
const CRYPTO = { name: '@aiqadam/qadam-crypto', version: '0.0.22' }
const log = { info: vi.fn(), warn: vi.fn() }

let tempDir: string
let seedDir: string
let root: string

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-seed-test-')))
    seedDir = join(tempDir, 'seed')
    root = join(tempDir, 'store')
    await mkdir(seedDir)
    log.warn.mockClear()
})

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreSeed.seedFromImage', () => {
    it('stores every version the image ships, then finds them present on the next start', async () => {
        await writeSeed({ artifacts: [await packArtifact(CSV), await packArtifact(CRYPTO)] })
        const store = await openStore()

        const first = await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })
        const second = await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })

        expect(first).toEqual({ status: SeedStatus.DONE, reason: null, stored: 2, present: 0, kept: 0, failed: [] })
        expect(second).toEqual({ status: SeedStatus.DONE, reason: null, stored: 0, present: 2, kept: 0, failed: [] })
        const read = await store.read({ coordinates: { platformId: null, ...CSV }, verify: true })
        expect(read.status === QadamVersionReadStatus.PRESENT && read.version.integrity.origin.kind).toBe(QadamVersionOrigin.IMAGE_SEED)
    })

    it('seeds each version once when several replicas start together', async () => {
        await writeSeed({ artifacts: [await packArtifact(CSV), await packArtifact(CRYPTO)] })
        const stores = await Promise.all([1, 2, 3].map(() => openStore()))

        const reports = await Promise.all(stores.map((store) => qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })))

        expect(reports.reduce((sum, report) => sum + report.stored, 0)).toBe(2)
        expect(reports.every((report) => report.failed.length === 0)).toBe(true)
        expect(await stores[0].listVersions({ platformId: null })).toHaveLength(2)
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('does nothing when the image carries no seed', async () => {
        const store = await openStore()

        const report = await qadamVersionStoreSeed.seedFromImage({ store, seedDir: join(tempDir, 'missing'), log })

        expect(report.status).toBe(SeedStatus.NO_SEED)
        expect(await store.listVersions({ platformId: null })).toEqual([])
    })

    it('reports a seed index it cannot read', async () => {
        await writeFile(join(seedDir, 'archive-index.json'), JSON.stringify({ formatVersion: 2, artifacts: [] }))

        const report = await qadamVersionStoreSeed.seedFromImage({ store: await openStore(), seedDir, log })

        expect(report.status).toBe(SeedStatus.INVALID_SEED)
    })

    it('fails the one version whose tarball is wrong or outside the seed, and still seeds the rest', async () => {
        const csv = await packArtifact(CSV)
        const crypto = await packArtifact(CRYPTO)
        await writeFile(join(tempDir, 'outside.tgz'), 'x')
        const store = await openStore()
        await writeSeed({ artifacts: [
            { ...csv, integrity: tarFixtures.integrity({ data: Buffer.from('not this tarball') }) },
            { ...crypto, file: '../outside.tgz' },
            { name: '@aiqadam/qadam-json', version: '1.0.0', file: 'missing.tgz', integrity: csv.integrity },
            { name: 'not-official', version: '1.0.0', file: csv.file, integrity: csv.integrity },
            await packArtifact({ name: '@aiqadam/qadam-http', version: '0.9.0' }),
        ] })

        const report = await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })

        expect(report.stored).toBe(1)
        expect(report.failed.map((failure) => failure.qadam)).toEqual([
            '@aiqadam/qadam-csv@0.6.0',
            '@aiqadam/qadam-crypto@0.0.22',
            '@aiqadam/qadam-json@1.0.0',
            'not-official@1.0.0',
        ])
        expect(report.failed[0].reason).toBe('the tarball does not match its expected integrity')
        expect(report.failed[1].reason).toBe('the index names a tarball outside the seed directory')
        expect(log.warn).toHaveBeenCalledTimes(4)
    })

    it('keeps a stored version a later release wrote, instead of replacing it with the image\'s', async () => {
        const store = await openStore()
        await writeSeed({ artifacts: [await packArtifact(CSV)] })
        await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })
        const integrityPath = join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0', 'integrity.json')
        const newer = { ...JSON.parse(await readFile(integrityPath, 'utf8')), storeFormatVersion: 2 }
        await writeFile(integrityPath, JSON.stringify(newer))

        const report = await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })

        expect(report).toMatchObject({ stored: 0, present: 0, kept: 1, failed: [] })
        expect(JSON.parse(await readFile(integrityPath, 'utf8'))).toEqual(newer)
    })

    it('keeps a version already in the store even when the image ships a different file for it', async () => {
        const store = await openStore()
        await writeSeed({ artifacts: [await packArtifact(CSV)] })
        await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })
        await writeSeed({ artifacts: [await packArtifact({ ...CSV, extra: { 'src/extra.js': 'rebuilt' } })] })

        const report = await qadamVersionStoreSeed.seedFromImage({ store, seedDir, log })

        expect(report).toMatchObject({ stored: 0, present: 1 })
        expect(log.warn).toHaveBeenCalledWith({ qadam: '@aiqadam/qadam-csv@0.6.0' }, expect.stringContaining('the stored one is kept'))
    })
})

async function openStore(): Promise<QadamVersionStore> {
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    return opened.store
}

async function packArtifact({ name, version, extra }: { name: string, version: string, extra?: Record<string, string> }): Promise<SeedArtifact> {
    const data = tarFixtures.tarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name, version, extra }) }) })
    const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
    await writeFile(join(seedDir, file), data)
    return { name, version, kind: 'bundle', file, integrity: tarFixtures.integrity({ data }) }
}

async function writeSeed({ artifacts }: { artifacts: Partial<SeedArtifact>[] }): Promise<void> {
    await writeFile(join(seedDir, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts }))
}

type SeedArtifact = {
    name: string
    version: string
    kind: string
    file: string
    integrity: string
}
