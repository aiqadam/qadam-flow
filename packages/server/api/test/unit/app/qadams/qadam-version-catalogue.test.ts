import { readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, Server } from 'node:http'
import path from 'node:path'
import { safeHttp } from '@aiqadam/server-utils'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { QadamVersionCatalogue, qadamVersionCatalogue } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue'
import { QADAM_VERSION_CATALOGUE_DEFAULT_URL } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-format'
import { QadamVersionCatalogueSource, qadamVersionCatalogueSource } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-source'
import { qadamVersionCatalogueWriter } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-writer'
import { catalogueFixtures } from './qadam-version-catalogue-fixtures'

const CSV = '@aiqadam/qadam-csv'
const TABLES = '@aiqadam/qadam-tables'

let root: string
let catalogueDir: string

describe('qadam version catalogue reader (#778)', () => {
    beforeEach(async () => {
        root = await catalogueFixtures.tempDir('qadam-catalogue-reader-')
        catalogueDir = path.join(root, 'catalog', 'v1')
        const archiveDir = path.join(root, 'archive')
        await catalogueFixtures.writeArchive({ archiveDir, artifacts: [
            { name: CSV, version: '0.10.0' },
            { name: CSV, version: '0.9.0' },
            { name: TABLES, version: '0.5.1', metadata: catalogueFixtures.metadata({ name: TABLES, version: '0.5.1', overrides: { maximumSupportedRelease: '9.0.0' } }) },
        ] })
        const written = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
        expect(written.status).toBe('appended')
    })

    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    describe('from a directory (the snapshot a :slim image carries)', () => {
        it('reads what the writer wrote: names, versions in semver order, entries and verified metadata', async () => {
            const read = await qadamVersionCatalogue.read({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            if (read.status !== 'ok') {
                throw new Error(`expected a catalogue, got ${read.status}`)
            }
            expect(read.skippedEntries).toBe(0)
            const { catalogue } = read
            expect(catalogue.names()).toEqual([CSV, TABLES])
            expect(catalogue.versions({ name: CSV })).toEqual(['0.9.0', '0.10.0'])
            expect(catalogue.versions({ name: '@aiqadam/qadam-unknown' })).toEqual([])
            expect(catalogue.entry({ name: TABLES, version: '0.5.1' })).toMatchObject({
                artifact: { format: 'bundle', kind: 'bundle' },
                minimumSupportedRelease: '0.82.0',
                maximumSupportedRelease: '9.0.0',
            })
            const metadata = await catalogue.readMetadata({ name: CSV, version: '0.9.0' })
            expect(metadata).toEqual({ status: 'ok', metadata: expect.objectContaining({ name: CSV, version: '0.9.0', displayName: `Fixture ${CSV}` }) })
            // `z.custom`: nothing the qadam put in its metadata is stripped on the way through.
            expect(metadata.status === 'ok' && metadata.metadata.i18n).toEqual({ ru: { 'Say hello': 'Скажи привет' } })
        })

        it('answers not-in-catalogue for a version it does not list', async () => {
            const catalogue = await readOk({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            expect(await catalogue.readMetadata({ name: CSV, version: '0.8.0' })).toEqual({ status: 'not-in-catalogue' })
        })

        it('refuses metadata that does not match the integrity in the index', async () => {
            const file = path.join(catalogueDir, 'qadams', CSV, '0.9.0', 'metadata.json')
            const original = await readFile(file, 'utf8')
            await writeFile(file, original.replace('A fixture qadam', 'A fixture qadaM'))
            const catalogue = await readOk({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            expect(await catalogue.readMetadata({ name: CSV, version: '0.9.0' })).toEqual({ status: 'integrity-mismatch' })
        })

        it('refuses metadata that matches its integrity but names another version', async () => {
            const index = await readIndex()
            const misplaced = Buffer.from(JSON.stringify(catalogueFixtures.metadata({ name: CSV, version: '0.10.0' })))
            await writeFile(path.join(catalogueDir, 'qadams', CSV, '0.9.0', 'metadata.json'), misplaced)
            index.qadams[CSV].versions['0.9.0'].metadata = { integrity: catalogueFixtures.sha512(misplaced), size: misplaced.length }
            await writeIndex({ index })
            const catalogue = await readOk({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            expect(await catalogue.readMetadata({ name: CSV, version: '0.9.0' })).toEqual({ status: 'invalid', reason: 'metadata names another qadam version' })
        })

        it('answers unavailable for a listed version whose metadata file is missing', async () => {
            await rm(path.join(catalogueDir, 'qadams', CSV, '0.9.0', 'metadata.json'))
            const catalogue = await readOk({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            expect(await catalogue.readMetadata({ name: CSV, version: '0.9.0' })).toEqual({ status: 'unavailable', reason: 'no metadata file' })
        })

        it('answers unavailable when there is no index', async () => {
            const source = qadamVersionCatalogueSource.directory({ root: path.join(root, 'nothing-here') })

            expect(await qadamVersionCatalogue.read({ source })).toEqual({ status: 'unavailable', reason: 'no index' })
        })

        it('refuses a path that leaves the catalogue root, and a file over the size bound', async () => {
            await writeFile(path.join(root, 'outside.json'), '{}')
            const source = qadamVersionCatalogueSource.directory({ root: catalogueDir })

            expect(await source.read({ relativePath: '../../outside.json', maxBytes: 1024 })).toEqual({ status: 'error', reason: 'path outside the catalogue root' })
            expect(await source.read({ relativePath: 'index.json', maxBytes: 16 })).toEqual({ status: 'error', reason: 'too large' })
        })
    })

    describe('forward compatibility (schema 1 only grows)', () => {
        it('ignores fields it does not know and skips entries it cannot parse, keeping the rest', async () => {
            const index = await readIndex()
            index.publishedBy = 'a later release'
            index.qadams[CSV].deprecated = true
            index.qadams[CSV].versions['0.9.0'].signature = { keyId: 'later' }
            index.qadams[CSV].versions['0.10.0'].artifact.format = 'oci-image'
            index.qadams[TABLES].versions['not-a-version'] = index.qadams[TABLES].versions['0.5.1']
            index.qadams['@someone/qadam-evil'] = { versions: { '1.0.0': index.qadams[TABLES].versions['0.5.1'] } }
            await writeIndex({ index })

            const read = await qadamVersionCatalogue.read({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })

            if (read.status !== 'ok') {
                throw new Error(`expected a catalogue, got ${read.status}`)
            }
            expect(read.skippedEntries).toBe(3)
            expect(read.catalogue.names()).toEqual([CSV, TABLES])
            expect(read.catalogue.versions({ name: CSV })).toEqual(['0.9.0'])
            expect((await read.catalogue.readMetadata({ name: CSV, version: '0.9.0' })).status).toBe('ok')
        })

        it('answers unsupported for another schema version, which a v1 reader cannot interpret', async () => {
            const index = await readIndex()
            index.schemaVersion = 2
            await writeIndex({ index })

            expect(await qadamVersionCatalogue.read({ source: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })).toEqual({ status: 'unsupported', schemaVersion: 2 })
        })

        it('answers invalid for an index that is not a catalogue', async () => {
            const source = qadamVersionCatalogueSource.directory({ root: catalogueDir })
            await writeFile(path.join(catalogueDir, 'index.json'), '<html>404</html>')
            expect(await qadamVersionCatalogue.read({ source })).toEqual({ status: 'invalid', reason: 'index is not JSON' })

            await writeFile(path.join(catalogueDir, 'index.json'), JSON.stringify({ versions: [] }))
            expect(await qadamVersionCatalogue.read({ source })).toEqual({ status: 'invalid', reason: 'index is not a qadam version catalogue' })
        })
    })

    describe('over HTTP (GitHub Pages, or a mirror)', () => {
        let server: Server
        let baseUrl: string
        const requests: string[] = []

        beforeAll(async () => {
            server = createServer((request, response) => {
                requests.push(request.url ?? '')
                const relative = decodeURIComponent((request.url ?? '/').replace(/^\/mirror\/catalog\/v1\//, ''))
                readFile(path.join(catalogueDir, relative)).then(
                    (bytes) => response.writeHead(200, { 'content-type': 'application/json' }).end(bytes),
                    () => response.writeHead(404).end('not found'),
                )
            })
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
            const address = server.address()
            if (typeof address !== 'object' || address === null) {
                throw new Error('the fixture server has no port')
            }
            baseUrl = `http://127.0.0.1:${address.port}/mirror/catalog/v1/`
        })

        afterAll(async () => {
            await new Promise((resolve) => server.close(resolve))
        })

        beforeEach(() => {
            requests.length = 0
        })

        it('reads the index and verified metadata from a base URL, with or without a trailing slash', async () => {
            const client = allowLoopbackClient()
            for (const base of [baseUrl, baseUrl.slice(0, -1)]) {
                const catalogue = await readOk({ source: qadamVersionCatalogueSource.http({ baseUrl: base, client }) })
                expect(catalogue.versions({ name: CSV })).toEqual(['0.9.0', '0.10.0'])
                expect((await catalogue.readMetadata({ name: TABLES, version: '0.5.1' })).status).toBe('ok')
            }
            expect(requests).toContain('/mirror/catalog/v1/index.json')
            expect(requests).toContain(`/mirror/catalog/v1/qadams/${TABLES}/0.5.1/metadata.json`)
        })

        it('answers unavailable for a base URL with no catalogue behind it', async () => {
            const client = allowLoopbackClient()
            const missing = await qadamVersionCatalogue.read({ source: qadamVersionCatalogueSource.http({ baseUrl: baseUrl.replace('/v1/', '/v9/'), client }) })

            expect(missing).toEqual({ status: 'unavailable', reason: 'no index' })
        })

        it('goes through the SSRF filter: the default client refuses a loopback mirror', async () => {
            const read = await qadamVersionCatalogue.read({ source: qadamVersionCatalogueSource.http({ baseUrl }) })

            expect(read.status).toBe('unavailable')
            expect(JSON.stringify(read)).not.toContain('127.0.0.1')
            expect(requests).toEqual([])
        })

        it('refuses a base URL that is not http(s), and a path that would leave the base', async () => {
            const notHttp = qadamVersionCatalogueSource.http({ baseUrl: 'file:///etc/' })
            expect(await notHttp.read({ relativePath: 'index.json', maxBytes: 1024 })).toEqual({ status: 'error', reason: 'invalid base URL' })

            const source = qadamVersionCatalogueSource.http({ baseUrl, client: allowLoopbackClient() })
            expect(await source.read({ relativePath: '../../index.json', maxBytes: 1024 })).toEqual({ status: 'error', reason: 'path outside the catalogue root' })
            expect(await source.read({ relativePath: 'https://example.com/index.json', maxBytes: 1024 })).toEqual({ status: 'error', reason: 'path outside the catalogue root' })
            expect(requests).toEqual([])
        })

        it('refuses a response over the size bound', async () => {
            const source = qadamVersionCatalogueSource.http({ baseUrl, client: allowLoopbackClient() })

            const read = await source.read({ relativePath: 'index.json', maxBytes: 16 })

            expect(read.status).toBe('error')
        })
    })

    it('defaults to GitHub Pages under flow.aiqadam.org (ADR-0003)', () => {
        expect(QADAM_VERSION_CATALOGUE_DEFAULT_URL).toBe('https://flow.aiqadam.org/catalog/v1/')
    })
})

function allowLoopbackClient(): ReturnType<typeof safeHttp.createAxios> {
    vi.stubEnv('AP_SSRF_ALLOW_LIST', '127.0.0.1')
    try {
        return safeHttp.createAxios()
    }
    finally {
        vi.unstubAllEnvs()
    }
}

async function readOk({ source }: { source: QadamVersionCatalogueSource }): Promise<QadamVersionCatalogue> {
    const read = await qadamVersionCatalogue.read({ source })
    if (read.status !== 'ok') {
        throw new Error(`expected a catalogue, got ${JSON.stringify(read)}`)
    }
    return read.catalogue
}

async function readIndex(): Promise<any> {
    return JSON.parse(await readFile(path.join(catalogueDir, 'index.json'), 'utf8'))
}

async function writeIndex({ index }: { index: unknown }): Promise<void> {
    await writeFile(path.join(catalogueDir, 'index.json'), JSON.stringify(index, null, 2))
}
