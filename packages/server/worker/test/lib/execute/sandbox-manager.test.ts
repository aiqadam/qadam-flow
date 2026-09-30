import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApEnvironment, ExecutionMode, NetworkMode, RunEnvironment } from '@aiqadam/shared'

const mockGetSettings = vi.fn()

vi.mock('../../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
}))

vi.mock('../../../src/lib/execute/create-sandbox-for-job', () => ({
    createSandboxForJob: vi.fn().mockReturnValue({
        isReady: () => true,
        shutdown: vi.fn().mockResolvedValue(undefined),
    }),
}))

const { provisionMock } = vi.hoisted(() => ({ provisionMock: vi.fn() }))

vi.mock('../../../src/lib/cache/provisioner', () => ({
    provisioner: () => ({ provision: provisionMock }),
}))

vi.mock('../../../src/lib/config/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnValue({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}))

import { createSandboxManager } from '../../../src/lib/execute/sandbox-manager'
import { createSandboxForJob } from '../../../src/lib/execute/create-sandbox-for-job'
import { logger } from '../../../src/lib/config/logger'
import { Sandbox } from '../../../src/lib/sandbox/types'

function buildSettings({ executionMode, environment }: { executionMode: string, environment: string }) {
    return {
        PUBLIC_URL: 'http://localhost:3000',
        TRIGGER_TIMEOUT_SECONDS: 60,
        TRIGGER_HOOKS_TIMEOUT_SECONDS: 60,
        PAUSED_FLOW_TIMEOUT_DAYS: 30,
        EXECUTION_MODE: executionMode,
        FLOW_TIMEOUT_SECONDS: 600,
        LOG_LEVEL: 'info',
        LOG_PRETTY: 'false',
        ENVIRONMENT: environment,
        APP_WEBHOOK_SECRETS: '{}',
        MAX_FLOW_RUN_LOG_SIZE_MB: 10,
        MAX_FILE_SIZE_MB: 10,
        SANDBOX_MEMORY_LIMIT: '1024',
        SANDBOX_PROPAGATED_ENV_VARS: [],
        DEV_QADAMS: [],
        OTEL_ENABLED: false,
        FILE_STORAGE_LOCATION: '/tmp',
        S3_USE_SIGNED_URLS: 'false',
        EVENT_DESTINATION_TIMEOUT_SECONDS: 30,
        NETWORK_MODE: NetworkMode.UNRESTRICTED,
        SSRF_ALLOW_LIST: [],
    }
}

describe('sandbox-manager canReuseSandbox', () => {
    const log = logger

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('SANDBOX_PROCESS mode → sandbox NOT reusable (release invalidates)', async () => {
        mockGetSettings.mockReturnValue(buildSettings({
            executionMode: ExecutionMode.SANDBOX_PROCESS,
            environment: ApEnvironment.PRODUCTION,
        }))

        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        const mockApiClient = {} as never
        manager.acquire({ log, apiClient: mockApiClient })
        await manager.release(log)

        // After release with non-reusable mode, acquiring again should create a fresh sandbox
        // We verify by checking that invalidate was called (sandbox set to null)
        const { createSandboxForJob } = await import('../../../src/lib/execute/create-sandbox-for-job')
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)

        // Acquire again — should create new sandbox since previous was invalidated
        manager.acquire({ log, apiClient: mockApiClient })
        expect(createSandboxForJob).toHaveBeenCalledTimes(2)
    })

    it('SANDBOX_CODE_AND_PROCESS mode → sandbox NOT reusable (release invalidates)', async () => {
        mockGetSettings.mockReturnValue(buildSettings({
            executionMode: ExecutionMode.SANDBOX_CODE_AND_PROCESS,
            environment: ApEnvironment.PRODUCTION,
        }))

        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        const mockApiClient = {} as never
        manager.acquire({ log, apiClient: mockApiClient })
        await manager.release(log)

        const { createSandboxForJob } = await import('../../../src/lib/execute/create-sandbox-for-job')
        manager.acquire({ log, apiClient: mockApiClient })
        expect(createSandboxForJob).toHaveBeenCalledTimes(2)
    })

    it('SANDBOX_CODE_ONLY mode → sandbox reusable (release does NOT invalidate)', async () => {
        mockGetSettings.mockReturnValue(buildSettings({
            executionMode: ExecutionMode.SANDBOX_CODE_ONLY,
            environment: ApEnvironment.PRODUCTION,
        }))

        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        const mockApiClient = {} as never
        manager.acquire({ log, apiClient: mockApiClient })
        await manager.release(log)

        const { createSandboxForJob } = await import('../../../src/lib/execute/create-sandbox-for-job')
        // Acquire again — should reuse (not create new)
        manager.acquire({ log, apiClient: mockApiClient })
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)
    })

    it('UNSANDBOXED mode → sandbox reusable (release does NOT invalidate)', async () => {
        mockGetSettings.mockReturnValue(buildSettings({
            executionMode: ExecutionMode.UNSANDBOXED,
            environment: ApEnvironment.PRODUCTION,
        }))

        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        const mockApiClient = {} as never
        manager.acquire({ log, apiClient: mockApiClient })
        await manager.release(log)

        const { createSandboxForJob } = await import('../../../src/lib/execute/create-sandbox-for-job')
        manager.acquire({ log, apiClient: mockApiClient })
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)
    })

    it('DEVELOPMENT environment → sandbox reusable regardless of execution mode', async () => {
        mockGetSettings.mockReturnValue(buildSettings({
            executionMode: ExecutionMode.SANDBOX_PROCESS,
            environment: ApEnvironment.DEVELOPMENT,
        }))

        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        const mockApiClient = {} as never
        manager.acquire({ log, apiClient: mockApiClient })
        await manager.release(log)

        const { createSandboxForJob } = await import('../../../src/lib/execute/create-sandbox-for-job')
        manager.acquire({ log, apiClient: mockApiClient })
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)
    })
})

// #419: a slot's engine is started before its first job, so the job does not pay the cold start.
describe('sandbox-manager prewarm', () => {
    const log = logger
    const apiClient = {} as never

    function fakeSandbox({ start }: { start: () => Promise<void> }): Sandbox {
        return {
            id: 'prewarmed',
            start: vi.fn(start),
            execute: vi.fn(),
            shutdown: vi.fn().mockResolvedValue(undefined),
            isReady: vi.fn().mockReturnValue(true),
            getPid: vi.fn().mockReturnValue(4242),
            isBusy: vi.fn().mockReturnValue(false),
        }
    }

    function useMode(executionMode: ExecutionMode): void {
        mockGetSettings.mockReturnValue(buildSettings({ executionMode, environment: ApEnvironment.PRODUCTION }))
    }

    beforeEach(() => {
        vi.clearAllMocks()
        provisionMock.mockResolvedValue(undefined)
    })

    it('installs the engine and starts a platform-less sandbox that the first job then reuses', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        const sandbox = fakeSandbox({ start: async () => undefined })
        vi.mocked(createSandboxForJob).mockReturnValueOnce(sandbox)
        const manager = createSandboxManager({ boxId: 3, proxyPort: 1234 })

        await manager.prewarm({ log, apiClient })

        expect(provisionMock).toHaveBeenCalledWith({ pieces: [], codeSteps: [] })
        expect(createSandboxForJob).toHaveBeenCalledWith(expect.objectContaining({ boxId: 3, reusable: true, proxyPort: 1234 }))
        expect(sandbox.start).toHaveBeenCalledWith({ flowVersionId: undefined, platformId: '', mounts: [] })
        expect(manager.acquire({ log, apiClient })).toBe(sandbox)
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)
    })

    it('reads the job context the first job sets, not a context captured at prewarm time', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        vi.mocked(createSandboxForJob).mockReturnValueOnce(fakeSandbox({ start: async () => undefined }))
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        await manager.prewarm({ log, apiClient })
        const { getCurrentJobContext } = vi.mocked(createSandboxForJob).mock.calls[0][0]
        expect(getCurrentJobContext()).toBeNull()

        const jobContext = { runId: 'run-1', projectId: 'p-1', platformId: 'pl-1', environment: RunEnvironment.PRODUCTION, workerHandlerId: null, httpRequestId: null }
        manager.acquire({ log, apiClient, jobContext })

        expect(getCurrentJobContext()).toBe(jobContext)
    })

    it.each([ExecutionMode.SANDBOX_PROCESS, ExecutionMode.SANDBOX_CODE_AND_PROCESS])('does nothing in %s mode, where a sandbox serves one job', async (mode) => {
        useMode(mode)
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        await manager.prewarm({ log, apiClient })

        expect(provisionMock).not.toHaveBeenCalled()
        expect(createSandboxForJob).not.toHaveBeenCalled()
    })

    // A reused isolate sandbox mounts its first job's platform's custom qadams at start; one
    // prewarmed with no platform would never get them.
    it('does nothing for a reused isolate sandbox (dev under SANDBOX_PROCESS)', async () => {
        mockGetSettings.mockReturnValue(buildSettings({ executionMode: ExecutionMode.SANDBOX_PROCESS, environment: ApEnvironment.DEVELOPMENT }))
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        await manager.prewarm({ log, apiClient })

        expect(provisionMock).not.toHaveBeenCalled()
        expect(createSandboxForJob).not.toHaveBeenCalled()
    })

    it('reports the start failure, not a failure of the cleanup after it', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        const failed = fakeSandbox({ start: async () => { throw new Error('did not connect') } })
        vi.mocked(failed.shutdown).mockRejectedValueOnce(new Error('kill failed'))
        vi.mocked(createSandboxForJob).mockReturnValueOnce(failed)
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        await manager.prewarm({ log, apiClient })

        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ message: 'did not connect' }) }), expect.any(String))
    })

    it('does nothing when the slot already has a sandbox', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })
        manager.acquire({ log, apiClient })

        await manager.prewarm({ log, apiClient })

        expect(provisionMock).not.toHaveBeenCalled()
        expect(createSandboxForJob).toHaveBeenCalledTimes(1)
    })

    it('drops a sandbox that failed to start, without throwing, so the first job starts its own', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        const failed = fakeSandbox({ start: async () => { throw new Error('did not connect') } })
        vi.mocked(createSandboxForJob).mockReturnValueOnce(failed)
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        await expect(manager.prewarm({ log, apiClient })).resolves.toBeUndefined()

        expect(failed.shutdown).toHaveBeenCalled()
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ boxId: 1 }), expect.stringContaining('Prewarm failed'))
        expect(manager.acquire({ log, apiClient })).not.toBe(failed)
        expect(createSandboxForJob).toHaveBeenCalledTimes(2)
    })

    it('starts no sandbox when the engine install fails, without throwing', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        provisionMock.mockRejectedValueOnce(new Error('ENOSPC'))
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        await expect(manager.prewarm({ log, apiClient })).resolves.toBeUndefined()

        expect(createSandboxForJob).not.toHaveBeenCalled()
        expect(manager.getActiveSandbox()).toBeNull()
    })

    it('shuts down a sandbox whose slot was invalidated while it was starting', async () => {
        useMode(ExecutionMode.UNSANDBOXED)
        const started: { resolve: () => void } = { resolve: () => undefined }
        const sandbox = fakeSandbox({ start: () => new Promise<void>((resolve) => { started.resolve = resolve }) })
        vi.mocked(createSandboxForJob).mockReturnValueOnce(sandbox)
        const manager = createSandboxManager({ boxId: 1, proxyPort: null })

        const prewarming = manager.prewarm({ log, apiClient })
        await vi.waitFor(() => expect(sandbox.start).toHaveBeenCalled())
        await manager.shutdown(log)
        vi.mocked(sandbox.shutdown).mockClear()
        started.resolve()
        await prewarming

        expect(sandbox.shutdown).toHaveBeenCalledTimes(1)
        expect(manager.getActiveSandbox()).toBeNull()
    })
})
