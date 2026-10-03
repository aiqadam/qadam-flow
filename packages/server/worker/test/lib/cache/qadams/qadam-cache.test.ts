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
    ])('answers name %j, outside the npm package-name grammar, as not found without building a cache path', async (qadamName) => {
        const { apiClient, methods } = fakeApiClient()

        await expect(qadamCache(log, apiClient).getPiece({ qadamName, qadamVersion: '1.0.0', platformId: 'platform_1' }))
            .rejects.toBeInstanceOf(PieceNotFoundError)

        expect(methods).toEqual([])
        expect(await readdir(cacheRoot)).toEqual([])
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
