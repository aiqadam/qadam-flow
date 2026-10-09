import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { qadamVersionCatalogueWriter } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-writer'
import { catalogueFixtures, FIXTURE_COMMIT, FixtureArtifact } from './qadam-version-catalogue-fixtures'

const CSV = '@aiqadam/qadam-csv'
const TABLES = '@aiqadam/qadam-tables'

let root: string
let catalogueDir: string

describe('qadam version catalogue writer (#778)', () => {
    beforeEach(async () => {
        root = await catalogueFixtures.tempDir('qadam-catalogue-writer-')
        catalogueDir = path.join(root, 'catalog', 'v1')
    })

    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    it('creates a catalogue from #804 --pack output, reusing each tarball\'s own metadata.json byte for byte', async () => {
        const archiveDir = path.join(root, 'archive-1')
        const [csv, tables] = await catalogueFixtures.writeArchive({ archiveDir, artifacts: [
            { name: CSV, version: '0.6.0' },
            { name: TABLES, version: '0.5.1', kind: 'bundle-with-node-modules' },
        ] })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })

        expect(result).toEqual({ status: 'appended', added: [{ name: CSV, version: '0.6.0' }, { name: TABLES, version: '0.5.1' }], unchanged: [] })
        const index = JSON.parse(await readFile(path.join(catalogueDir, 'index.json'), 'utf8'))
        expect(index).toEqual({
            schemaVersion: 1,
            qadams: {
                [CSV]: { versions: { '0.6.0': {
                    artifact: { format: 'bundle', kind: 'bundle', integrity: csv.indexEntry.integrity, size: csv.indexEntry.size },
                    metadata: { integrity: catalogueFixtures.sha512(csv.metadataBytes), size: csv.metadataBytes.length },
                    minimumSupportedRelease: '0.82.0',
                    commit: FIXTURE_COMMIT,
                } } },
                [TABLES]: { versions: { '0.5.1': {
                    artifact: { format: 'bundle', kind: 'bundle-with-node-modules', integrity: tables.indexEntry.integrity, size: tables.indexEntry.size },
                    metadata: { integrity: catalogueFixtures.sha512(tables.metadataBytes), size: tables.metadataBytes.length },
                    minimumSupportedRelease: '0.82.0',
                    commit: FIXTURE_COMMIT,
                } } },
            },
        })
        expect(await readFile(path.join(catalogueDir, 'qadams', CSV, '0.6.0', 'metadata.json'))).toEqual(csv.metadataBytes)
        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'ok', qadams: 2, versions: 2 })
    })

    it('is idempotent: the same archive again changes no byte', async () => {
        const archiveDir = path.join(root, 'archive-1')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        const before = await readFile(path.join(catalogueDir, 'index.json'))

        const again = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })

        expect(again).toEqual({ status: 'appended', added: [], unchanged: [{ name: CSV, version: '0.6.0' }] })
        expect(await readFile(path.join(catalogueDir, 'index.json'))).toEqual(before)
    })

    it('appends a later release beside the earlier one, in semver order', async () => {
        const first = path.join(root, 'archive-1')
        const second = path.join(root, 'archive-2')
        await catalogueFixtures.writeArchive({ archiveDir: first, artifacts: [{ name: CSV, version: '0.9.0' }] })
        await catalogueFixtures.writeArchive({ archiveDir: second, artifacts: [{ name: CSV, version: '0.10.0' }, { name: TABLES, version: '1.0.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: first })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: second })

        expect(result.status).toBe('appended')
        const index = JSON.parse(await readFile(path.join(catalogueDir, 'index.json'), 'utf8'))
        expect(Object.keys(index.qadams)).toEqual([CSV, TABLES])
        expect(Object.keys(index.qadams[CSV].versions)).toEqual(['0.9.0', '0.10.0'])
        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'ok', qadams: 2, versions: 3 })
    })

    it('refuses a version that is already in the catalogue with different content, and writes nothing', async () => {
        const first = path.join(root, 'archive-1')
        const rebuilt = path.join(root, 'archive-rebuilt')
        await catalogueFixtures.writeArchive({ archiveDir: first, artifacts: [{ name: CSV, version: '0.6.0', marker: 'original' }] })
        await catalogueFixtures.writeArchive({ archiveDir: rebuilt, artifacts: [{ name: CSV, version: '0.6.0', marker: 'rebuilt' }, { name: TABLES, version: '0.5.1' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: first })
        const before = await snapshotTree({ dir: catalogueDir })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: rebuilt })

        expect(result).toEqual({ status: 'refused', problems: [{ name: CSV, version: '0.6.0', reason: expect.stringContaining('never republished') }] })
        expect(await snapshotTree({ dir: catalogueDir })).toEqual(before)
    })

    it.each<[string, FixtureArtifact, string]>([
        ['a non-official name', { name: '@someone/qadam-csv', version: '1.0.0' }, 'not an official qadam name'],
        ['a name outside the qadam prefix', { name: '@aiqadam/shared', version: '1.0.0' }, 'not an official qadam name'],
        ['a snapshot prerelease (ADR-0004)', { name: CSV, version: '1.3.0-main.412' }, 'prerelease'],
        ['a version with build metadata', { name: CSV, version: '1.0.0+abc' }, 'not a canonical semver version'],
        ['a dirty build', { name: CSV, version: '1.0.0', indexOverrides: { commit: { sha: FIXTURE_COMMIT, dirtyQadams: true } } }, 'clean commit'],
        ['an unknown kind', { name: CSV, version: '1.0.0', kind: 'docker-image' }, 'unknown artifact kind'],
        ['a tarball path that leaves the archive', { name: CSV, version: '1.0.0', indexOverrides: { file: '../elsewhere.tgz' } }, 'plain .tgz file name'],
        ['a wrong integrity', { name: CSV, version: '1.0.0', indexOverrides: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } }, 'does not match the integrity'],
        ['a legacy npm package (no qadamArtifact marker)', { name: CSV, version: '1.0.0', packageJson: { name: CSV, version: '1.0.0', main: './src/index.js' } }, 'package.json does not name'],
        ['a package.json for another version', { name: CSV, version: '1.0.0', packageJson: { name: CSV, version: '1.0.1', qadamArtifact: { formatVersion: 1, kind: 'bundle' } } }, 'package.json does not name'],
        ['an unknown artifact format version', { name: CSV, version: '1.0.0', packageJson: { name: CSV, version: '1.0.0', qadamArtifact: { formatVersion: 2, kind: 'bundle' } } }, 'not a format-1 artifact'],
        ['no metadata.json (built with --no-load-check)', { name: CSV, version: '1.0.0', withMetadata: false }, 'cannot read package/metadata.json'],
        ['metadata for another version', { name: CSV, version: '1.0.0', metadata: catalogueFixtures.metadata({ name: CSV, version: '0.9.9' }) }, 'not qadam metadata for this qadam version'],
        ['metadata without actions', { name: CSV, version: '1.0.0', metadata: catalogueFixtures.metadata({ name: CSV, version: '1.0.0', overrides: { actions: [] } }) }, 'not qadam metadata'],
    ])('refuses %s, and one bad artifact refuses the whole run', async (_label, artifact, reason) => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: TABLES, version: '0.5.1' }, artifact] })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })

        expect(result).toEqual({ status: 'refused', problems: [{ name: artifact.name, version: artifact.version, reason: expect.stringContaining(reason) }] })
        expect(await snapshotTree({ dir: catalogueDir })).toEqual({})
    })

    it('refuses an archive index that lists a version twice', async () => {
        const archiveDir = path.join(root, 'archive')
        const entries = await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '1.0.0' }] })
        await writeFile(path.join(archiveDir, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts: [entries[0].indexEntry, entries[0].indexEntry] }))

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })

        expect(result).toEqual({ status: 'refused', problems: [{ name: CSV, version: '1.0.0', reason: 'listed twice in the archive index' }] })
    })

    it('refuses an archive index of another format', async () => {
        const archiveDir = path.join(root, 'archive')
        await mkdir(archiveDir, { recursive: true })
        await writeFile(path.join(archiveDir, 'archive-index.json'), JSON.stringify({ formatVersion: 2, artifacts: [] }))

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'refused', problems: [{ reason: expect.stringContaining('not a format-1 archive index') }] })
    })

    it('refuses to rewrite an index carrying a field it does not know, which it would otherwise drop', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        const indexPath = path.join(catalogueDir, 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf8'))
        index.qadams[CSV].versions['0.6.0'].addedByALaterRelease = true
        await writeFile(indexPath, JSON.stringify(index))
        const next = path.join(root, 'archive-2')
        await catalogueFixtures.writeArchive({ archiveDir: next, artifacts: [{ name: TABLES, version: '0.5.1' }] })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: next })

        expect(result).toEqual({ status: 'refused', problems: [{ reason: expect.stringContaining('cannot be appended to') }] })
        expect(JSON.parse(await readFile(indexPath, 'utf8')).qadams[TABLES]).toBeUndefined()
    })

    it('refuses to append to a catalogue whose published metadata no longer matches its index', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        await writeFile(path.join(catalogueDir, 'qadams', CSV, '0.6.0', 'metadata.json'), '{"tampered":true}')
        const next = path.join(root, 'archive-2')
        await catalogueFixtures.writeArchive({ archiveDir: next, artifacts: [{ name: TABLES, version: '0.5.1' }] })

        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'invalid', problems: [{ name: CSV, version: '0.6.0', reason: 'metadata file does not match its integrity' }] })
        expect((await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: next })).status).toBe('refused')
    })

    it('refuses metadata files with no index rather than starting a new catalogue over them', async () => {
        await mkdir(path.join(catalogueDir, 'qadams'), { recursive: true })
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'refused', problems: [{ reason: 'the catalogue has metadata files but no index' }] })
    })

    it('reuses a metadata file an interrupted run left behind, and refuses a different one', async () => {
        const archiveDir = path.join(root, 'archive')
        const [csv] = await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        const leftover = path.join(catalogueDir, 'qadams', CSV, '0.6.0', 'metadata.json')
        await mkdir(path.dirname(leftover), { recursive: true })
        await writeFile(path.join(catalogueDir, 'index.json'), JSON.stringify({ schemaVersion: 1, qadams: {} }))
        await writeFile(leftover, csv.metadataBytes)

        expect((await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).status).toBe('appended')
        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'ok', qadams: 1, versions: 1 })

        const other = path.join(root, 'archive-2')
        await catalogueFixtures.writeArchive({ archiveDir: other, artifacts: [{ name: TABLES, version: '0.5.1' }] })
        const otherLeftover = path.join(catalogueDir, 'qadams', TABLES, '0.5.1', 'metadata.json')
        await mkdir(path.dirname(otherLeftover), { recursive: true })
        await writeFile(otherLeftover, '{}')

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: other })).toEqual({ status: 'refused', problems: [{ name: TABLES, version: '0.5.1', reason: 'a different metadata file is already in place' }] })
    })

    it('verify reports a missing index', async () => {
        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'invalid', problems: [{ reason: 'no index' }] })
    })
})

async function snapshotTree({ dir }: { dir: string }): Promise<Record<string, string>> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
    const files = entries.filter((entry) => entry.isFile())
    const contents = await Promise.all(files.map(async (entry) => {
        const full = path.join(entry.parentPath, entry.name)
        return [path.relative(dir, full), (await readFile(full)).toString('base64')] as const
    }))
    return Object.fromEntries(contents)
}
