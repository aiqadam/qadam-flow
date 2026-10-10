import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApEnvironment, createRpcClient, PackageType, QadamType, WorkerToApiContract } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PieceNotFoundError, qadamCache } from '../../../../src/lib/cache/qadams/qadam-cache'

let cacheRoot = ''

vi.mock('../../../../src/lib/cache/cache-paths', () => ({
    getGlobalCacheQadamsPath: () => cacheRoot,
}))

vi.mock('../../../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: () => ({
            ENVIRONMENT: ApEnvironment.PRODUCTION,
            DEV_QADAMS: [],
        }),
    },
}))

const log = pino({ level: 'silent' })

beforeEach(async () => {
    cacheRoot = join(tmpdir(), `qadam-cache-test-${randomUUID()}`)
    await mkdir(cacheRoot, { recursive: true })
})

afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true })
})

describe('qadamCache.getPiece', () => {
    it.each([
        ['../x'],
        ['@acme/../../x'],
        ['Upper'],
        [`${'a-'.repeat(50_000)}b`],
    ])('answers name %j, outside the npm package-name grammar, as not found without building a cache path', async (qadamName) => {
        const { apiClient, methods } = fakeApiClient()

        await expect(qadamCache(log, apiClient).getPiece({ qadamName, qadamVersion: '1.0.0', platformId: 'platform_1' }))
            .rejects.toBeInstanceOf(PieceNotFoundError)

        expect(methods).toEqual([])
        expect(await readdir(cacheRoot)).toEqual([])
    })

    // Agent tools carry a version nothing validated (#779); the API throws a plain Error on these,
    // which provisioning rethrows, and ON_DISABLE and every tick would fail on it (#432).
    it.each([
        ['latest'],
        [''],
        ['1.0'],
        ['^1.0.0 garbage'],
        ['1.2.0-beta.1'],
    ])('answers version %j, which is no pin, as not found without asking the API', async (qadamVersion) => {
        const { apiClient, methods } = fakeApiClient()

        await expect(qadamCache(log, apiClient).getPiece({ qadamName: '@acme/qadam-a', qadamVersion, platformId: 'platform_1' }))
            .rejects.toBeInstanceOf(PieceNotFoundError)

        expect(methods).toEqual([])
        expect(await readdir(cacheRoot)).toEqual([])
    })

    // The cache folder is one path segment named `<name>-<version>-<platform>`, so a name inside npm's
    // 214 characters with a long exact version is still past the filesystem's 255 bytes: the read
    // rethrew ENAMETOOLONG as a plain Error (#779). Such a pin is not cached; it asks the API.
    const SNAPSHOT_44 = '999999999.999999999.999999999-main.999999999'
    const PLATFORM_21 = 'p'.repeat(21)

    it.each([
        ['a 214-character name with a 44-character snapshot version', 'a'.repeat(214), SNAPSHOT_44, false],
        ['a 200-character name with a 44-character snapshot version', 'a'.repeat(200), SNAPSHOT_44, false],
        ['a 214-character name with a short snapshot version', 'a'.repeat(214), '1.0.0-main.999999999', false],
        ['a long scoped name whose scope folder already exists', `@aiqadam/${'a'.repeat(200)}`, SNAPSHOT_44, true],
    ])('resolves %s through the API without a cache folder or ENAMETOOLONG', async (_label, qadamName, qadamVersion, scopeFolderExists) => {
        if (scopeFolderExists) {
            await mkdir(join(cacheRoot, '@aiqadam'))
        }
        const { apiClient, methods } = fakeApiClient()

        const piece = await qadamCache(log, apiClient).getPiece({ qadamName, qadamVersion, platformId: PLATFORM_21 })

        expect(piece).toMatchObject({ packageType: PackageType.REGISTRY })
        expect(methods).toEqual(['getQadam'])
        const written = await readdir(cacheRoot, { recursive: true })
        expect(written.filter((entry) => entry.length > 100)).toEqual([])
    })

    it('still caches a pin whose folder name fits', async () => {
        const { apiClient, methods } = fakeApiClient()
        const qadamCacheForTest = qadamCache(log, apiClient)

        await qadamCacheForTest.getPiece({ qadamName: 'a'.repeat(150), qadamVersion: '1.0.0', platformId: PLATFORM_21 })
        await qadamCacheForTest.getPiece({ qadamName: 'a'.repeat(150), qadamVersion: '1.0.0', platformId: PLATFORM_21 })

        expect(methods).toEqual(['getQadam'])
    })

    it('still resolves and caches a name inside the grammar', async () => {
        const { apiClient, methods } = fakeApiClient()

        const piece = await qadamCache(log, apiClient).getPiece({ qadamName: '@acme/qadam-a', qadamVersion: '1.0.0', platformId: 'platform_1' })

        expect(piece).toMatchObject({ qadamName: '@acme/qadam-a', qadamVersion: '1.0.0' })
        expect(methods).toEqual(['getQadam'])
        expect(await readdir(cacheRoot)).not.toEqual([])
    })
})

// The real RPC proxy over a socket that answers in-process: a genuine WorkerToApiContract whose
// only answered method is `getQadam`, recording the name of every method called.
function fakeApiClient(): { apiClient: WorkerToApiContract, methods: string[] } {
    const methods: string[] = []
    const socket = {
        emit: () => undefined,
        on: () => undefined,
        timeout: () => ({
            emitWithAck: async (_event: string, message: unknown) => {
                const method = readMethod(message)
                methods.push(method)
                if (method !== 'getQadam') {
                    return undefined
                }
                return {
                    name: '@acme/qadam-a',
                    version: '1.0.0',
                    packageType: PackageType.REGISTRY,
                    qadamType: QadamType.CUSTOM,
                }
            },
        }),
    }
    return { apiClient: createRpcClient<WorkerToApiContract>(socket, 1_000), methods }
}

function readMethod(message: unknown): string {
    if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') {
        throw new Error('unexpected RPC message')
    }
    return message.method
}
