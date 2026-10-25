import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import { PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { qadamVersionStoreFixtures } from './qadam-version-store-fixtures'

const NAME = '@aiqadam/qadam-fixture'
const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const original = process.env[STORE_ENV]

const loadBundledQadams = vi.fn()
const loadRegistry = vi.fn()

vi.mock('../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

vi.mock('../../../../src/app/qadams/metadata/qadam-cache', () => ({
    qadamCache: () => ({
        setup: async () => undefined,
        loadRegistry: (...args: unknown[]) => loadRegistry(...args),
        invalidate: async () => undefined,
    }),
}))

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

let tempDir: string

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-metadata-store-')))
    process.env[STORE_ENV] = join(tempDir, 'store')
    vi.clearAllMocks()
    loadRegistry.mockResolvedValue([])
    loadBundledQadams.mockResolvedValue([])
})

afterEach(async () => {
    if (original === undefined) {
        delete process.env[STORE_ENV]
    }
    else {
        process.env[STORE_ENV] = original
    }
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamMetadataService — a stored version (unit)', () => {
    it('serves the metadata of a version only the store holds, as an official registry qadam', async () => {
        await seed({ versions: ['1.3.0'] })

        const result = await qadamMetadataService(logger).get({ name: NAME, version: '1.3.0' })

        expect(result).toMatchObject({
            name: NAME,
            version: '1.3.0',
            qadamType: QadamType.OFFICIAL,
            packageType: PackageType.REGISTRY,
        })
        expect(result?.actions.say_hello).toBeDefined()
    })

    it('prefers the stored version over the image build of the same version', async () => {
        await seed({ versions: ['1.3.0'], displayName: 'Stored build' })
        loadBundledQadams.mockResolvedValue([bundledQadam({ version: '1.3.0', displayName: 'Image build' })])

        const result = await qadamMetadataService(logger).get({ name: NAME, version: '1.3.0' })

        expect(result?.displayName).toBe('Stored build')
    })

    it('answers a snapshot pin the store holds', async () => {
        await seed({ versions: ['1.3.0-main.412'] })

        const result = await qadamMetadataService(logger).get({ name: NAME, version: '1.3.0-main.412' })

        expect(result?.version).toBe('1.3.0-main.412')
    })

    it('ignores a stored version whose metadata cannot be read, without throwing', async () => {
        await seed({ versions: ['1.3.0'] })
        await rm(join(process.env[STORE_ENV]!, 'qadams', '@aiqadam', 'qadam-fixture', '1.3.0', 'metadata.json'))

        expect(await qadamMetadataService(logger).get({ name: NAME, version: '1.3.0' })).toBeUndefined()
    })

    it('resolves a stored pin for the batch and availability paths', async () => {
        await seed({ versions: ['1.3.0'] })
        const service = qadamMetadataService(logger)

        expect(await service.isPinAvailable({ name: NAME, version: '1.3.0', platformId: undefined })).toBe(true)
        expect((await service.resolveVersions({ pins: [{ name: NAME, version: '1.3.0' }] })).get(`${NAME}@1.3.0`)).toEqual({ status: 'resolved', version: '1.3.0' })
        expect((await service.getMany({ pins: [{ name: NAME, version: '1.3.0' }] })).get(`${NAME}@1.3.0`)).toMatchObject({ status: 'found' })
    })

    it('lists a stored version in the registry once, even when the registry already names it', async () => {
        await seed({ versions: ['1.3.0'] })
        loadRegistry.mockResolvedValue([{ name: NAME, version: '1.3.0', qadamType: QadamType.OFFICIAL, platformId: undefined }])

        expect(await qadamMetadataService(logger).registry({ release: '0.82.0' })).toEqual([{ name: NAME, version: '1.3.0' }])
    })

    it('honours a stored version\'s release floors in the registry', async () => {
        await seed({ versions: ['1.3.0'] })
        const service = qadamMetadataService(logger)

        expect(await service.registry({ release: '0.82.0' })).toEqual([{ name: NAME, version: '1.3.0' }])
        expect(await service.registry({ release: '0.80.0' })).toEqual([])
    })
})

async function seed({ versions, displayName }: SeedOptions): Promise<void> {
    await qadamVersionStoreFixtures.seed({
        root: process.env[STORE_ENV]!,
        seedDir: join(tempDir, 'seed'),
        artifacts: versions.map((version) => qadamVersionStoreFixtures.artifact({ name: NAME, version, overrides: displayName === undefined ? {} : { displayName } })),
    })
}

function bundledQadam({ version, displayName }: { version: string, displayName: string }): QadamMetadataModel {
    return {
        name: NAME,
        displayName,
        logoUrl: '',
        description: '',
        authors: [],
        version,
        actions: {},
        triggers: {},
        contextInfo: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    }
}

type SeedOptions = {
    versions: string[]
    displayName?: string
}
