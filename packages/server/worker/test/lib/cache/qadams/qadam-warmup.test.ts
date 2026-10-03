import { createRpcClient, PackageType, QadamPackage, QadamType, WorkerToApiContract } from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamWarmup } from '../../../../src/lib/cache/qadams/qadam-warmup'

const mockInstall = vi.fn()

// Only `install` is replaced: the predicate the warmup partitions with is the installer's own.
vi.mock('../../../../src/lib/cache/qadams/qadam-installer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/lib/cache/qadams/qadam-installer')>()
    return {
        qadamInstaller: (...args: Parameters<typeof actual.qadamInstaller>) => ({
            ...actual.qadamInstaller(...args),
            install: mockInstall,
        }),
    }
})

const log = pino({ level: 'silent' })

beforeEach(() => {
    mockInstall.mockReset()
    mockInstall.mockResolvedValue(undefined)
})

describe('qadamWarmup.warmupUsedQadams', () => {
    it('installs the installable entries and sets aside one outside the name grammar', async () => {
        const good = makeQadam({ qadamName: '@acme/qadam-a', qadamVersion: '1.0.0' })
        const bad = makeQadam({ qadamName: 'Upper', qadamVersion: '1.0.0' })
        const { apiClient, calls } = fakeApiClient({ usedQadams: [bad, good] })
        const warn = vi.spyOn(log, 'warn')

        await qadamWarmup.warmupUsedQadams({ apiClient, log })

        expect(mockInstall).toHaveBeenCalledExactlyOnceWith({ pieces: [good], includeFilters: true })
        expect(calls).toContainEqual({ method: 'markQadamAsUsed', payload: { pieces: [good] } })
        expect(warn).toHaveBeenCalledWith(
            { refused: [{ qadamName: 'Upper', qadamVersion: '1.0.0' }] },
            expect.any(String),
        )
    })

    it('sets aside an entry whose version is not a single path segment', async () => {
        const good = makeQadam({ qadamName: '@acme/qadam-a', qadamVersion: '1.0.0' })
        const bad = makeQadam({ qadamName: '@acme/qadam-b', qadamVersion: '1.0.0/x' })
        const { apiClient } = fakeApiClient({ usedQadams: [good, bad] })

        await qadamWarmup.warmupUsedQadams({ apiClient, log })

        expect(mockInstall).toHaveBeenCalledExactlyOnceWith({ pieces: [good], includeFilters: true })
    })

    it('installs nothing when every entry is set aside', async () => {
        const { apiClient, calls } = fakeApiClient({ usedQadams: [makeQadam({ qadamName: '../x', qadamVersion: '1.0.0' })] })

        await qadamWarmup.warmupUsedQadams({ apiClient, log })

        expect(mockInstall).not.toHaveBeenCalled()
        expect(calls.map((call) => call.method)).not.toContain('markQadamAsUsed')
    })
})

function makeQadam({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }): QadamPackage {
    return {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.CUSTOM,
        qadamName,
        qadamVersion,
        platformId: 'platform_1',
    }
}

// The real RPC proxy over a socket that answers in-process, so the client is a genuine
// WorkerToApiContract and every call it makes is recorded.
function fakeApiClient({ usedQadams }: { usedQadams: QadamPackage[] }): { apiClient: WorkerToApiContract, calls: RpcCall[] } {
    const calls: RpcCall[] = []
    const socket = {
        emit: () => undefined,
        on: () => undefined,
        timeout: () => ({
            emitWithAck: async (_event: string, message: unknown) => {
                const call = toRpcCall(message)
                calls.push(call)
                return call.method === 'getUsedQadams' ? usedQadams : undefined
            },
        }),
    }
    return { apiClient: createRpcClient<WorkerToApiContract>(socket, 1_000), calls }
}

function toRpcCall(message: unknown): RpcCall {
    if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') {
        throw new Error('unexpected RPC message')
    }
    return { method: message.method, payload: 'payload' in message ? message.payload : undefined }
}

type RpcCall = {
    method: string
    payload: unknown
}
