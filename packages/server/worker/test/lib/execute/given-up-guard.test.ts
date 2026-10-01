import { createRpcClient, FlowRunStatus, RunEnvironment } from '@aiqadam/shared'
import type { WorkerToApiContract } from '@aiqadam/shared'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { engineRunScope } from '../../../src/lib/execute/engine-run-scope'
import { givenUpGuard, JobGivenUpError } from '../../../src/lib/execute/given-up-guard'
import type { SandboxJobContext, SandboxManager } from '../../../src/lib/execute/sandbox-manager'
import type { Sandbox } from '../../../src/lib/sandbox/types'

const log = pino({ level: 'silent' })

/**
 * #585: a job this worker gave up may already run on another worker. Nothing it does from then on
 * may reach the API, or it would write over the copy's run.
 */
describe('givenUpGuard', () => {
    describe('apiClient', () => {
        it('passes calls through while the job is still this worker\'s', async () => {
            const uploadRunLog = vi.fn().mockResolvedValue(undefined)
            const client = givenUpGuard.apiClient({ apiClient: apiClientWith({ uploadRunLog }), isGivenUp: () => false })

            await client.uploadRunLog(runLog())

            expect(uploadRunLog).toHaveBeenCalledWith(runLog())
        })

        it('sends nothing once the job is given up', async () => {
            let givenUp = false
            const uploadRunLog = vi.fn().mockResolvedValue(undefined)
            const client = givenUpGuard.apiClient({ apiClient: apiClientWith({ uploadRunLog }), isGivenUp: () => givenUp })
            givenUp = true

            await expect(client.uploadRunLog(runLog())).rejects.toBeInstanceOf(JobGivenUpError)
            expect(uploadRunLog).not.toHaveBeenCalled()
        })
    })

    describe('sandboxManager', () => {
        it('refuses a sandbox, fresh or prewarmed, to a job already given up', () => {
            const manager = fakeManager()
            const guarded = givenUpGuard.sandboxManager({ sandboxManager: manager, isGivenUp: () => true })

            expect(() => guarded.acquire({ log, apiClient: apiClientWith({}), jobContext: jobContext() })).toThrow(JobGivenUpError)
            expect(manager.acquire).not.toHaveBeenCalled()
        })

        // A reused or prewarmed sandbox forwards the engine's calls with the client it was created
        // with, so the job context is the only thing that reaches them.
        it('hands the job context on with a live view of the job\'s state', () => {
            let givenUp = false
            const manager = fakeManager()
            const guarded = givenUpGuard.sandboxManager({ sandboxManager: manager, isGivenUp: () => givenUp })

            guarded.acquire({ log, apiClient: apiClientWith({}), jobContext: jobContext() })
            const passed: SandboxJobContext = manager.acquire.mock.calls[0][0].jobContext
            expect(passed).toMatchObject(jobContext())
            expect(passed.isGivenUp?.()).toBe(false)
            givenUp = true
            expect(passed.isGivenUp?.()).toBe(true)
        })
    })
})

describe('engineRunScope for a given-up job', () => {
    it('drops the engine\'s run-scoped calls once the job is given up', () => {
        let givenUp = false
        const context: SandboxJobContext = { ...jobContext(), isGivenUp: () => givenUp }
        const scope = engineRunScope.create({ log, getCurrentJobContext: () => context })
        expect(() => scope.assertOwnsRun({ rpc: 'uploadRunLog', runId: 'run-1', projectId: 'proj-1' })).not.toThrow()

        givenUp = true

        expect(() => scope.assertOwnsRun({ rpc: 'uploadRunLog', runId: 'run-1', projectId: 'proj-1' })).toThrow(JobGivenUpError)
        expect(() => scope.assertOwnsSyncRequest({ workerHandlerId: 'handler-1', httpRequestId: 'request-1' })).toThrow(JobGivenUpError)
    })
})

function jobContext(): SandboxJobContext {
    return {
        runId: 'run-1',
        projectId: 'proj-1',
        platformId: 'plat-1',
        environment: RunEnvironment.PRODUCTION,
        workerHandlerId: 'handler-1',
        httpRequestId: 'request-1',
    }
}

function runLog(): Parameters<WorkerToApiContract['uploadRunLog']>[0] {
    return { runId: 'run-1', projectId: 'proj-1', status: FlowRunStatus.INTERNAL_ERROR }
}

// The real RPC client over a socket that answers in-process: typed as the contract, no cast.
function apiClientWith(methods: Partial<Record<keyof WorkerToApiContract, (input: unknown) => unknown>>): WorkerToApiContract {
    return createRpcClient<WorkerToApiContract>({
        emit: () => undefined,
        on: () => undefined,
        timeout: () => ({
            emitWithAck: async (_event: string, message: unknown) => {
                if (!isRpcMessage(message)) {
                    throw new Error('not an RPC message')
                }
                const method = Object.entries(methods).find(([name]) => name === message.method)?.[1]
                return method?.(message.payload)
            },
        }),
    }, 1_000)
}

function isRpcMessage(value: unknown): value is { method: string, payload: unknown } {
    return typeof value === 'object' && value !== null && 'method' in value && typeof value.method === 'string'
}

function fakeManager(): SandboxManager & { acquire: ReturnType<typeof vi.fn> } {
    const sandbox: Sandbox = {
        id: 'sandbox-1',
        start: vi.fn(),
        execute: vi.fn(),
        shutdown: vi.fn(),
        isReady: () => true,
        getPid: () => 1,
        isBusy: () => false,
    }
    return {
        acquire: vi.fn(() => sandbox),
        prewarm: vi.fn(),
        invalidate: vi.fn(),
        release: vi.fn(),
        shutdown: vi.fn(),
        markStale: vi.fn(),
        getActiveSandbox: () => null,
    }
}
