import { ApEnvironment, ErrorCode, ExecutionMode, FlowRunStatus, NetworkMode, RunEnvironment, UpdateRunProgressRequest, WorkerContract } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSettingsMock, createSandboxMock, isolateProcessMock, simpleProcessMock, getGlobalCacheCommonPathMock, getGlobalCodeCachePathMock, getEnginePathMock, provisionFlowPiecesMock } = vi.hoisted(() => ({
    getSettingsMock: vi.fn(),
    createSandboxMock: vi.fn(),
    isolateProcessMock: vi.fn(() => ({ create: vi.fn() })),
    simpleProcessMock: vi.fn(() => ({ create: vi.fn() })),
    getGlobalCacheCommonPathMock: vi.fn(() => '/tmp/cache/common'),
    getGlobalCodeCachePathMock: vi.fn(() => '/tmp/cache/codes'),
    getEnginePathMock: vi.fn(() => '/tmp/cache/common/main.js'),
    provisionFlowPiecesMock: vi.fn(),
}))

vi.mock('../../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: (...args: unknown[]) => getSettingsMock(...args),
    },
}))

vi.mock('../../../src/lib/sandbox/sandbox', () => ({
    createSandbox: createSandboxMock,
}))

vi.mock('../../../src/lib/sandbox/isolate', () => ({
    isolateProcess: isolateProcessMock,
}))

vi.mock('../../../src/lib/sandbox/fork', () => ({
    simpleProcess: simpleProcessMock,
}))

vi.mock('../../../src/lib/cache/cache-paths', () => ({
    getGlobalCacheCommonPath: getGlobalCacheCommonPathMock,
    getGlobalCodeCachePath: getGlobalCodeCachePathMock,
    getEnginePath: getEnginePathMock,
}))

vi.mock('../../../src/lib/execute/utils/flow-helpers', () => ({
    provisionFlowPieces: provisionFlowPiecesMock,
}))

import { createSandboxForJob } from '../../../src/lib/execute/create-sandbox-for-job'
import { SandboxJobContext } from '../../../src/lib/execute/sandbox-manager'

type Settings = {
    PUBLIC_URL: string
    TRIGGER_TIMEOUT_SECONDS: number
    TRIGGER_HOOKS_TIMEOUT_SECONDS: number
    PAUSED_FLOW_TIMEOUT_DAYS: number
    EXECUTION_MODE: string
    FLOW_TIMEOUT_SECONDS: number
    LOG_LEVEL: string
    LOG_PRETTY: string
    ENVIRONMENT: string
    APP_WEBHOOK_SECRETS: string
    MAX_FLOW_RUN_LOG_SIZE_MB: number
    MAX_FILE_SIZE_MB: number
    SANDBOX_MEMORY_LIMIT: string
    SANDBOX_PROPAGATED_ENV_VARS: string[]
    DEV_QADAMS: string[]
    OTEL_ENABLED: boolean
    FILE_STORAGE_LOCATION: string
    S3_USE_SIGNED_URLS: string
    EVENT_DESTINATION_TIMEOUT_SECONDS: number
    NETWORK_MODE: NetworkMode
    SSRF_ALLOW_LIST: string[]
}

function buildSettings(overrides: Partial<Settings> = {}): Settings {
    const base: Settings = {
        PUBLIC_URL: 'http://localhost:3000',
        TRIGGER_TIMEOUT_SECONDS: 60,
        TRIGGER_HOOKS_TIMEOUT_SECONDS: 60,
        PAUSED_FLOW_TIMEOUT_DAYS: 30,
        EXECUTION_MODE: ExecutionMode.SANDBOX_PROCESS,
        FLOW_TIMEOUT_SECONDS: 600,
        LOG_LEVEL: 'info',
        LOG_PRETTY: 'false',
        ENVIRONMENT: ApEnvironment.PRODUCTION,
        APP_WEBHOOK_SECRETS: '{}',
        MAX_FLOW_RUN_LOG_SIZE_MB: 10,
        MAX_FILE_SIZE_MB: 10,
        SANDBOX_MEMORY_LIMIT: '1048576',
        SANDBOX_PROPAGATED_ENV_VARS: [],
        DEV_QADAMS: [],
        OTEL_ENABLED: false,
        FILE_STORAGE_LOCATION: '/tmp',
        S3_USE_SIGNED_URLS: 'false',
        EVENT_DESTINATION_TIMEOUT_SECONDS: 30,
        NETWORK_MODE: NetworkMode.UNRESTRICTED,
        SSRF_ALLOW_LIST: [],
    }
    return { ...base, ...overrides }
}

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
const apiClient = {} as never

describe('createSandboxForJob', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createSandboxMock.mockReturnValue({ id: 'sb', start: vi.fn(), execute: vi.fn(), shutdown: vi.fn(), isReady: vi.fn() })
    })

    describe('baseMounts', () => {
        it('contains exactly /root/common → getGlobalCacheCommonPath()', () => {
            getSettingsMock.mockReturnValue(buildSettings())
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            const options = createSandboxMock.mock.calls[0][2]
            expect(options.baseMounts).toEqual([
                { hostPath: '/tmp/cache/common', sandboxPath: '/root/common' },
            ])
        })

        it('never leaks host / or /etc into baseMounts', () => {
            getSettingsMock.mockReturnValue(buildSettings())
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            const options = createSandboxMock.mock.calls[0][2]
            for (const mount of options.baseMounts) {
                expect(mount.hostPath).not.toBe('/')
                expect(mount.hostPath).not.toBe('/etc')
                expect(mount.sandboxPath.startsWith('/root/') || mount.sandboxPath === '/root').toBe(true)
            }
        })
    })

    describe('processMaker selection', () => {
        it.each([
            [ExecutionMode.SANDBOX_PROCESS, 'isolate'],
            [ExecutionMode.SANDBOX_CODE_AND_PROCESS, 'isolate'],
        ])('uses isolateProcess for %s', (executionMode) => {
            getSettingsMock.mockReturnValue(buildSettings({ EXECUTION_MODE: executionMode }))
            createSandboxForJob({ log, apiClient, boxId: 7, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            expect(isolateProcessMock).toHaveBeenCalledTimes(1)
            expect(simpleProcessMock).not.toHaveBeenCalled()
            expect(isolateProcessMock).toHaveBeenCalledWith(log, '/tmp/cache/common/main.js', '/tmp/cache/codes', 7)
        })

        it.each([
            [ExecutionMode.UNSANDBOXED, 'simple'],
            [ExecutionMode.SANDBOX_CODE_ONLY, 'simple'],
        ])('uses simpleProcess for %s', (executionMode) => {
            getSettingsMock.mockReturnValue(buildSettings({ EXECUTION_MODE: executionMode }))
            createSandboxForJob({ log, apiClient, boxId: 3, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            expect(simpleProcessMock).toHaveBeenCalledTimes(1)
            expect(isolateProcessMock).not.toHaveBeenCalled()
            expect(simpleProcessMock).toHaveBeenCalledWith('/tmp/cache/common/main.js', '/tmp/cache/codes')
        })
    })

    describe('buildSandboxEnv', () => {
        it('emits all required keys including NODE_PATH (STRICT when proxyPort is set)', () => {
            getSettingsMock.mockReturnValue(buildSettings({
                EXECUTION_MODE: ExecutionMode.SANDBOX_PROCESS,
                MAX_FLOW_RUN_LOG_SIZE_MB: 25,
                MAX_FILE_SIZE_MB: 50,
                NETWORK_MODE: NetworkMode.STRICT,
            }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: 49321, getCurrentJobContext: () => null })

            const env = createSandboxMock.mock.calls[0][2].env
            expect(env).toMatchObject({
                HOME: '/tmp/',
                AP_EXECUTION_MODE: ExecutionMode.SANDBOX_PROCESS,
                AP_MAX_FLOW_RUN_LOG_SIZE_MB: '25',
                AP_MAX_FILE_SIZE_MB: '50',
                NODE_PATH: '/usr/src/node_modules',
                AP_NETWORK_MODE: NetworkMode.STRICT,
                AP_EGRESS_PROXY_URL: 'http://127.0.0.1:49321',
            })
        })

        it('omits AP_DEV_QADAMS when DEV_QADAMS is empty', () => {
            getSettingsMock.mockReturnValue(buildSettings({ DEV_QADAMS: [] }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            const env = createSandboxMock.mock.calls[0][2].env
            expect(env.AP_DEV_QADAMS).toBeUndefined()
        })

        it('joins DEV_QADAMS with comma', () => {
            getSettingsMock.mockReturnValue(buildSettings({ DEV_QADAMS: ['a', 'b', 'c'] }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            const env = createSandboxMock.mock.calls[0][2].env
            expect(env.AP_DEV_QADAMS).toBe('a,b,c')
        })

        it('only propagates env vars that exist in process.env (no undefined leak)', () => {
            const originalProcessEnv = { ...process.env }
            try {
                process.env['PROPAGATED_YES'] = 'forwarded'
                delete process.env['PROPAGATED_NO']
                getSettingsMock.mockReturnValue(buildSettings({
                    SANDBOX_PROPAGATED_ENV_VARS: ['PROPAGATED_YES', 'PROPAGATED_NO'],
                }))
                createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

                const env = createSandboxMock.mock.calls[0][2].env
                expect(env.PROPAGATED_YES).toBe('forwarded')
                expect('PROPAGATED_NO' in env).toBe(false)
            }
            finally {
                process.env = originalProcessEnv
            }
        })
    })

    describe('parseMemoryLimit', () => {
        it('converts KB string to MB', () => {
            getSettingsMock.mockReturnValue(buildSettings({ SANDBOX_MEMORY_LIMIT: '524288' }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            expect(createSandboxMock.mock.calls[0][2].memoryLimitMb).toBe(512)
        })

        it('defaults to 1024 MB on invalid input', () => {
            getSettingsMock.mockReturnValue(buildSettings({ SANDBOX_MEMORY_LIMIT: 'not-a-number' }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            expect(createSandboxMock.mock.calls[0][2].memoryLimitMb).toBe(1024)
        })
    })

    it('forwards reusable flag into createSandbox options', () => {
        getSettingsMock.mockReturnValue(buildSettings())
        createSandboxForJob({ log, apiClient, boxId: 1, reusable: true, proxyPort: null, getCurrentJobContext: () => null })

        expect(createSandboxMock.mock.calls[0][2].reusable).toBe(true)
    })

    // The sandbox network env follows the egress stack's runtime state (proxyPort),
    // not the live workerSettings.NETWORK_MODE. The stack starts once at worker boot;
    // settings refresh on every reconnect. Keying off proxyPort prevents the
    // STRICT iptables + missing AP_EGRESS_PROXY_URL drift that surfaces as
    // EHOSTUNREACH ("fetch failed") in user code-pieces.
    describe('sandbox network env follows proxyPort, not live settings', () => {
        it('proxyPort=null + NETWORK_MODE=STRICT in settings → engine sees UNRESTRICTED, no proxy URL', () => {
            // Drift scenario: settings flipped STRICT after boot but the egress stack
            // was never (re)started, so the firewall isn't actually armed. Telling the
            // engine it is would install ProxyAgent pointed at nothing.
            getSettingsMock.mockReturnValue(buildSettings({ NETWORK_MODE: NetworkMode.STRICT }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: null, getCurrentJobContext: () => null })

            const env = createSandboxMock.mock.calls[0][2].env
            expect(env.AP_NETWORK_MODE).toBe(NetworkMode.UNRESTRICTED)
            expect('AP_EGRESS_PROXY_URL' in env).toBe(false)
        })

        it('proxyPort=<port> + NETWORK_MODE=UNRESTRICTED in settings → engine sees STRICT, proxy URL set', () => {
            // Drift scenario users actually hit: settings flipped UNRESTRICTED after
            // boot, but iptables is still armed and the proxy is still listening.
            // Engine MUST install ProxyAgent or every fetch fails with EHOSTUNREACH.
            getSettingsMock.mockReturnValue(buildSettings({ NETWORK_MODE: NetworkMode.UNRESTRICTED }))
            createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: 49322, getCurrentJobContext: () => null })

            const env = createSandboxMock.mock.calls[0][2].env
            expect(env.AP_NETWORK_MODE).toBe(NetworkMode.STRICT)
            expect(env.AP_EGRESS_PROXY_URL).toBe('http://127.0.0.1:49322')
        })

        it('blocks HTTP_PROXY-style propagated env vars when STRICT is derived from proxyPort, not settings', () => {
            const originalProcessEnv = { ...process.env }
            try {
                process.env['HTTP_PROXY'] = 'http://leak:3128'
                process.env['HTTPS_PROXY'] = 'http://leak:3128'
                getSettingsMock.mockReturnValue(buildSettings({
                    NETWORK_MODE: NetworkMode.UNRESTRICTED,
                    SANDBOX_PROPAGATED_ENV_VARS: ['HTTP_PROXY', 'HTTPS_PROXY'],
                }))
                createSandboxForJob({ log, apiClient, boxId: 1, reusable: false, proxyPort: 49323, getCurrentJobContext: () => null })

                const env = createSandboxMock.mock.calls[0][2].env
                expect('HTTP_PROXY' in env).toBe(false)
                expect('HTTPS_PROXY' in env).toBe(false)
            }
            finally {
                process.env = originalProcessEnv
            }
        })
    })
})

// The engine is untrusted: every run-scoped RPC it makes is checked against the job the worker
// dequeued before it reaches the API (#512).
describe('engine RPC run scope', () => {
    const JOB: SandboxJobContext = {
        runId: 'run-own',
        projectId: 'project-own',
        platformId: 'platform-own',
        environment: RunEnvironment.PRODUCTION,
        workerHandlerId: 'handler-own',
        httpRequestId: 'request-own',
    }

    function buildApiClient() {
        return {
            uploadRunLog: vi.fn().mockResolvedValue(undefined),
            updateRunProgress: vi.fn().mockResolvedValue(undefined),
            updateStepProgress: vi.fn().mockResolvedValue(undefined),
            sendFlowResponse: vi.fn().mockResolvedValue(undefined),
            startInlineFlowRun: vi.fn().mockResolvedValue({
                ok: true,
                flowVersion: { flowId: 'child-flow' },
                childRunId: 'run-child',
                childLogsFileId: 'logs-child',
                inlineDepth: 1,
            }),
        }
    }

    function setup({ jobContext }: { jobContext: () => SandboxJobContext | null }) {
        getSettingsMock.mockReturnValue(buildSettings())
        const client = buildApiClient()
        createSandboxForJob({ log, apiClient: client as never, boxId: 1, reusable: true, proxyPort: null, getCurrentJobContext: jobContext })
        const handlers: WorkerContract = createSandboxMock.mock.calls[0][4]
        return { client, handlers }
    }

    function uploadFor({ runId, projectId }: { runId: string, projectId: string }) {
        return { runId, projectId, status: FlowRunStatus.RUNNING }
    }

    function stepProgressFor({ runId, projectId }: { runId: string, projectId: string }) {
        return {
            projectId,
            stepResponse: { runId, success: true, input: {}, output: {}, standardError: '', standardOutput: '' },
        }
    }

    function runProgressFor({ runId, projectId }: { runId: string, projectId: string }): UpdateRunProgressRequest {
        const now = new Date().toISOString()
        return {
            flowRun: {
                id: runId,
                projectId,
                flowId: 'flow-own',
                flowVersionId: 'flow-version-own',
                status: FlowRunStatus.RUNNING,
                environment: RunEnvironment.PRODUCTION,
                failParentOnFailure: false,
                logsFileId: null,
                archivedAt: null,
                tags: [],
                created: now,
                updated: now,
            },
        }
    }

    const refused = expect.objectContaining({ error: expect.objectContaining({ code: ErrorCode.AUTHORIZATION }) })

    beforeEach(() => {
        vi.clearAllMocks()
        createSandboxMock.mockReturnValue({ id: 'sb' })
        provisionFlowPiecesMock.mockResolvedValue({ provisioned: true })
    })

    it('forwards uploadRunLog for the job\'s own run', async () => {
        const { client, handlers } = setup({ jobContext: () => JOB })
        const input = uploadFor({ runId: 'run-own', projectId: 'project-own' })

        await handlers.uploadRunLog(input)

        expect(client.uploadRunLog).toHaveBeenCalledWith(input)
    })

    it.each([
        ['another run in the same project', { runId: 'run-foreign', projectId: 'project-own' }],
        ['its own run moved into another project', { runId: 'run-own', projectId: 'project-foreign' }],
        ['another project\'s run', { runId: 'run-foreign', projectId: 'project-foreign' }],
    ])('refuses uploadRunLog for %s', async (_label, target) => {
        const { client, handlers } = setup({ jobContext: () => JOB })

        await expect(handlers.uploadRunLog(uploadFor(target))).rejects.toEqual(refused)
        expect(client.uploadRunLog).not.toHaveBeenCalled()
    })

    it('refuses every run-scoped RPC when no flow job occupies the sandbox', async () => {
        const { client, handlers } = setup({ jobContext: () => null })

        await expect(handlers.uploadRunLog(uploadFor({ runId: 'run-own', projectId: 'project-own' }))).rejects.toEqual(refused)
        await expect(handlers.updateStepProgress(stepProgressFor({ runId: 'run-own', projectId: 'project-own' }))).rejects.toEqual(refused)
        await expect(handlers.sendFlowResponse({ workerHandlerId: 'handler-own', httpRequestId: 'request-own', runResponse: { status: 200, body: {}, headers: {} } })).rejects.toEqual(refused)
        expect(client.uploadRunLog).not.toHaveBeenCalled()
        expect(client.updateStepProgress).not.toHaveBeenCalled()
        expect(client.sendFlowResponse).not.toHaveBeenCalled()
    })

    it('refuses updateRunProgress addressed to another project', async () => {
        const { client, handlers } = setup({ jobContext: () => JOB })

        await expect(handlers.updateRunProgress(runProgressFor({ runId: 'run-own', projectId: 'project-foreign' }))).rejects.toEqual(refused)
        expect(client.updateRunProgress).not.toHaveBeenCalled()

        await handlers.updateRunProgress(runProgressFor({ runId: 'run-own', projectId: 'project-own' }))
        expect(client.updateRunProgress).toHaveBeenCalledTimes(1)
    })

    it('accepts an inline child only after the job itself spawned it', async () => {
        const { client, handlers } = setup({ jobContext: () => JOB })
        const childUpload = uploadFor({ runId: 'run-child', projectId: 'project-own' })

        await expect(handlers.uploadRunLog(childUpload)).rejects.toEqual(refused)

        const resolved = await handlers.resolveInlineFlow({ flowId: 'child-flow', payload: {}, parentRunId: 'run-own' })
        expect(resolved.ok).toBe(true)

        await handlers.uploadRunLog(childUpload)
        await handlers.updateStepProgress(stepProgressFor({ runId: 'run-child', projectId: 'project-own' }))
        expect(client.uploadRunLog).toHaveBeenCalledWith(childUpload)
        expect(client.updateStepProgress).toHaveBeenCalledTimes(1)
    })

    it('does not record a child whose inline start was refused', async () => {
        const { client, handlers } = setup({ jobContext: () => JOB })
        client.startInlineFlowRun.mockResolvedValue({ ok: false, error: 'not found' })

        await handlers.resolveInlineFlow({ flowId: 'child-flow', payload: {}, parentRunId: 'run-own' })

        await expect(handlers.uploadRunLog(uploadFor({ runId: 'run-child', projectId: 'project-own' }))).rejects.toEqual(refused)
    })

    it('forgets the previous job\'s runs when a reused sandbox takes the next job', async () => {
        let current: SandboxJobContext = JOB
        const { client, handlers } = setup({ jobContext: () => current })
        await handlers.resolveInlineFlow({ flowId: 'child-flow', payload: {}, parentRunId: 'run-own' })

        current = { ...JOB, runId: 'run-next' }

        await expect(handlers.uploadRunLog(uploadFor({ runId: 'run-own', projectId: 'project-own' }))).rejects.toEqual(refused)
        await expect(handlers.uploadRunLog(uploadFor({ runId: 'run-child', projectId: 'project-own' }))).rejects.toEqual(refused)
        await handlers.uploadRunLog(uploadFor({ runId: 'run-next', projectId: 'project-own' }))
        expect(client.uploadRunLog).toHaveBeenCalledTimes(1)
    })

    it('forwards sendFlowResponse only for the job\'s own sync request', async () => {
        const runResponse = { status: 200, body: {}, headers: {} }
        const { client, handlers } = setup({ jobContext: () => JOB })

        await expect(handlers.sendFlowResponse({ workerHandlerId: 'handler-own', httpRequestId: 'request-foreign', runResponse })).rejects.toEqual(refused)
        await expect(handlers.sendFlowResponse({ workerHandlerId: 'handler-foreign', httpRequestId: 'request-own', runResponse })).rejects.toEqual(refused)
        expect(client.sendFlowResponse).not.toHaveBeenCalled()

        await handlers.sendFlowResponse({ workerHandlerId: 'handler-own', httpRequestId: 'request-own', runResponse })
        expect(client.sendFlowResponse).toHaveBeenCalledTimes(1)
    })

    it('refuses sendFlowResponse for an async job, which has no sync caller to answer', async () => {
        const { client, handlers } = setup({ jobContext: () => ({ ...JOB, workerHandlerId: null, httpRequestId: null }) })

        await expect(handlers.sendFlowResponse({ workerHandlerId: 'handler-own', httpRequestId: 'request-own', runResponse: { status: 200, body: {}, headers: {} } })).rejects.toEqual(refused)
        expect(client.sendFlowResponse).not.toHaveBeenCalled()
    })
})
