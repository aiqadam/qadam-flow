import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamVersionCatalogueFormat } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-format'
import { storedQadamMetadata } from '../../../../src/app/qadams/metadata/utils/stored-qadam-metadata'
import { qadamVersionStoreFixtures } from './qadam-version-store-fixtures'

const NAME = '@aiqadam/qadam-fixture'
const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const original = process.env[STORE_ENV]

let tempDir: string
let store: string

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'stored-qadam-metadata-')))
    store = join(tempDir, 'store')
    process.env[STORE_ENV] = store
    storedQadamMetadata.reset()
})

afterEach(async () => {
    storedQadamMetadata.reset()
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (original === undefined) {
        delete process.env[STORE_ENV]
    }
    else {
        process.env[STORE_ENV] = original
    }
    await rm(tempDir, { recursive: true, force: true })
})

describe('storedQadamMetadata caches (unit)', () => {
    it('parses a version once and serves a repeat lookup from the metadata cache', async () => {
        await seedStore({ versions: ['1.3.0'] })
        const check = vi.spyOn(qadamVersionCatalogueFormat, 'checkMetadataFile')

        expect((await storedQadamMetadata.read({ name: NAME, version: '1.3.0' }))?.metadata.version).toBe('1.3.0')
        expect((await storedQadamMetadata.read({ name: NAME, version: '1.3.0' }))?.metadata.version).toBe('1.3.0')

        expect(check).toHaveBeenCalledTimes(1)
    })

    it('re-reads a version once its short cache has expired', async () => {
        await seedStore({ versions: ['1.3.0'] })
        const check = vi.spyOn(qadamVersionCatalogueFormat, 'checkMetadataFile')
        vi.useFakeTimers({ toFake: ['Date'] })

        await storedQadamMetadata.read({ name: NAME, version: '1.3.0' })
        vi.setSystemTime(Date.now() + 31_000)
        await storedQadamMetadata.read({ name: NAME, version: '1.3.0' })

        expect(check).toHaveBeenCalledTimes(2)
        vi.useRealTimers()
    })

    it('shares one registry walk between concurrent list calls', async () => {
        await seedStore({ versions: ['1.3.0', '1.4.0'] })
        const check = vi.spyOn(qadamVersionCatalogueFormat, 'checkMetadataFile')

        const [first, second] = await Promise.all([storedQadamMetadata.list(), storedQadamMetadata.list()])

        expect(first.map((entry) => entry.version)).toEqual(['1.3.0', '1.4.0'])
        expect(second).toEqual(first)
        expect(check).toHaveBeenCalledTimes(2)
    })

    it('keys a cached version by its store root', async () => {
        await seedStore({ versions: ['1.3.0'], displayName: 'First store' })
        expect((await storedQadamMetadata.read({ name: NAME, version: '1.3.0' }))?.metadata.displayName).toBe('First store')

        const secondStore = join(tempDir, 'second-store')
        await seedStore({ root: secondStore, versions: ['1.3.0'], displayName: 'Second store' })
        process.env[STORE_ENV] = secondStore

        expect((await storedQadamMetadata.read({ name: NAME, version: '1.3.0' }))?.metadata.displayName).toBe('Second store')
    })
})

async function seedStore({ root = store, versions, displayName }: { root?: string, versions: string[], displayName?: string }): Promise<void> {
    await qadamVersionStoreFixtures.seed({
        root,
        seedDir: join(tempDir, `seed-${root === store ? 'first' : 'second'}`),
        artifacts: versions.map((version) => qadamVersionStoreFixtures.artifact({
            name: NAME,
            version,
            overrides: displayName === undefined ? {} : { displayName },
        })),
    })
}
