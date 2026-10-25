import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextVersion } from '@aiqadam/qadams-framework'
import { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { frameworkCensusService } from '../../../../src/app/qadams/census/framework-census-service'
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
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'framework-census-store-')))
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

describe('frameworkCensusService.resolvePins — a version only the store holds (unit)', () => {
    it('reads the stored version\'s own context version', async () => {
        await seed({ version: '1.3.0', contextVersion: ContextVersion.V2 })

        const support = await frameworkCensusService(logger).resolvePins({ pins: [`${NAME}@1.3.0`], platformId: 'platform-a' })

        expect(support.get(`${NAME}@1.3.0`)).toMatchObject({ source: 'official', contextVersion: ContextVersion.V2, status: 'current' })
    })

    it('counts a stored version on an older context as legacy, not unknown', async () => {
        await seed({ version: '1.3.0', contextVersion: ContextVersion.V1 })

        const support = await frameworkCensusService(logger).resolvePins({ pins: [`${NAME}@1.3.0`], platformId: 'platform-a' })

        expect(support.get(`${NAME}@1.3.0`)).toMatchObject({ contextVersion: ContextVersion.V1, status: 'legacy' })
    })
})

async function seed({ version, contextVersion }: { version: string, contextVersion: ContextVersion }): Promise<void> {
    await qadamVersionStoreFixtures.seed({
        root: process.env[STORE_ENV]!,
        seedDir: join(tempDir, 'seed'),
        artifacts: [qadamVersionStoreFixtures.artifact({ name: NAME, version, overrides: { contextInfo: { version: contextVersion } } })],
    })
}
