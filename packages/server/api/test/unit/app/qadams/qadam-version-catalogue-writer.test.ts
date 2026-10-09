import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
        ['no metadata.json (built with --no-load-check)', { name: CSV, version: '1.0.0', withMetadata: false }, 'cannot read package/metadata.json from the tarball (tar: '],
        ['metadata for another version', { name: CSV, version: '1.0.0', metadata: catalogueFixtures.metadata({ name: CSV, version: '0.9.9' }) }, 'not qadam metadata for this qadam version'],
        ['metadata without actions', { name: CSV, version: '1.0.0', metadata: catalogueFixtures.metadata({ name: CSV, version: '1.0.0', overrides: { actions: [] } }) }, 'not qadam metadata'],
        // The index drops a `null` floor, so the entry would disagree with its own metadata file.
        ['a null release floor', { name: CSV, version: '1.0.0', metadata: catalogueFixtures.metadata({ name: CSV, version: '1.0.0', overrides: { minimumSupportedRelease: null } }) }, 'not qadam metadata'],
        ['a package.json over its size bound', { name: CSV, version: '1.0.0', packageJson: { name: CSV, version: '1.0.0', qadamArtifact: { formatVersion: 1, kind: 'bundle' }, padding: 'x'.repeat(1024 * 1024) } }, 'package/package.json is too large'],
    ])('refuses %s, and one bad artifact refuses the whole run', async (_label, artifact, reason) => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: TABLES, version: '0.5.1' }, artifact] })

        const result = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })

        expect(result).toEqual({ status: 'refused', problems: [{ name: artifact.name, version: artifact.version, reason: expect.stringContaining(reason) }] })
        expect(await snapshotTree({ dir: catalogueDir })).toEqual({})
    })

    it('reports a tar that cannot be run as a broken runner, not a bad artifact', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '1.0.0' }] })
        vi.stubEnv('PATH', path.join(root, 'no-tar-here'))
        try {
            expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'refused', problems: [{ name: CSV, version: '1.0.0', reason: 'cannot run tar: ENOENT' }] })
        }
        finally {
            vi.unstubAllEnvs()
        }
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

    it('refuses a catalogue that lost its index rather than writing a new index over its metadata files', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        await rm(path.join(catalogueDir, 'index.json'))
        const next = path.join(root, 'archive-2')
        await catalogueFixtures.writeArchive({ archiveDir: next, artifacts: [{ name: TABLES, version: '0.5.1' }] })
        const before = await snapshotTree({ dir: catalogueDir })

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir: next })).toEqual({ status: 'refused', problems: [{
            reason: `the catalogue has metadata files but no index, and this archive does not add qadams/${CSV}/0.6.0/metadata.json: restore index.json, or remove those files if this is meant to be a new catalogue`,
        }] })
        expect(await snapshotTree({ dir: catalogueDir })).toEqual(before)
    })

    it('refuses, with its own reason, when there is no index and the metadata directory cannot be listed', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [] })
        await mkdir(catalogueDir, { recursive: true })
        await writeFile(path.join(catalogueDir, 'qadams'), 'not a directory')

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'refused', problems: [{
            reason: 'there is no index.json, and the qadams/ directory cannot be listed to check it holds nothing this run does not add (ENOTDIR)',
        }] })
    })

    it('finishes a first run that stopped after its metadata files and before its index', async () => {
        const archiveDir = path.join(root, 'archive')
        const [csv] = await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }, { name: TABLES, version: '0.5.1' }] })
        const leftover = path.join(catalogueDir, 'qadams', CSV, '0.6.0', 'metadata.json')
        await mkdir(path.dirname(leftover), { recursive: true })
        await writeFile(leftover, csv.metadataBytes)

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'appended', added: [{ name: CSV, version: '0.6.0' }, { name: TABLES, version: '0.5.1' }], unchanged: [] })
        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'ok', qadams: 2, versions: 2 })
    })

    it('refuses a version listed again with the same bytes but another commit', async () => {
        const archiveDir = path.join(root, 'archive')
        const [csv] = await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        await writeFile(path.join(archiveDir, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts: [{ ...csv.indexEntry, commit: { sha: 'b'.repeat(40), dirtyQadams: false } }] }))
        const before = await snapshotTree({ dir: catalogueDir })

        expect(await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })).toEqual({ status: 'refused', problems: [{ name: CSV, version: '0.6.0', reason: expect.stringContaining('never republished') }] })
        expect(await snapshotTree({ dir: catalogueDir })).toEqual(before)
    })

    it('verify reports release floors in the index that differ from the metadata\'s', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        const indexPath = path.join(catalogueDir, 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf8'))
        index.qadams[CSV].versions['0.6.0'].minimumSupportedRelease = '0.90.0'
        await writeFile(indexPath, JSON.stringify(index))

        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'invalid', problems: [{ name: CSV, version: '0.6.0', reason: 'the index\'s release floors differ from the metadata\'s' }] })
    })

    it('verify reports a metadata file that matches its integrity but is not qadam metadata', async () => {
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [{ name: CSV, version: '0.6.0' }] })
        await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        const notMetadata = Buffer.from('{"tampered":true}')
        await writeFile(path.join(catalogueDir, 'qadams', CSV, '0.6.0', 'metadata.json'), notMetadata)
        const indexPath = path.join(catalogueDir, 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf8'))
        index.qadams[CSV].versions['0.6.0'].metadata = { integrity: catalogueFixtures.sha512(notMetadata), size: notMetadata.length }
        await writeFile(indexPath, JSON.stringify(index))

        expect(await qadamVersionCatalogueWriter.verify({ catalogueDir })).toEqual({ status: 'invalid', problems: [{ name: CSV, version: '0.6.0', reason: 'metadata file is not qadam metadata for this qadam version' }] })
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
