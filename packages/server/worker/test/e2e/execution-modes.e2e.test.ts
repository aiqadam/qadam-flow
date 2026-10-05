import { existsSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { EngineOperationType, EngineResponseStatus, ExecutionMode, ExecutionType, FlowActionType, FlowRunStatus, FlowTriggerType, FlowVersionState, NetworkMode, RunEnvironment, StreamStepProgress } from '@aiqadam/shared'
import type { BeginExecuteFlowOperation, FlowAction, FlowTrigger, FlowVersion, WorkerSettingsResponse } from '@aiqadam/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getGlobalCacheCommonPath, getGlobalCodeCachePath } from '../../src/lib/cache/cache-paths'
import { workerSettings } from '../../src/lib/config/worker-settings'
import { createSandboxForJob } from '../../src/lib/execute/create-sandbox-for-job'
import type { SandboxJobContext } from '../../src/lib/execute/sandbox-manager'
import { getIsolateExecutableName } from '../../src/lib/sandbox/isolate'
import { isolatePreflight } from '../../src/lib/sandbox/isolate-preflight'
import { inProcessApiClient } from '../fixtures/in-process-api-client'
import { requireIsolateBinary, requireLinuxPrivileged } from './helpers/privilege-guard'
import { silentLogger } from './helpers/silent-logger'

/**
 * #375's core ask: every `AP_EXECUTION_MODE` boots the worker's real sandbox and runs a basic flow
 * end to end. Before this, only `UNSANDBOXED` had ever executed; `SANDBOX_PROCESS` failed on the
 * first bundled qadam because nothing mounted the qadam tree into the isolate chroot, and
 * `SANDBOX_CODE_ONLY` was never exercised at all.
 *
 * This drives `createSandboxForJob` — the same factory the worker uses, so the mode -> process maker
 * choice, the mounts and the sandbox env are the production ones — then executes a `BEGIN` flow
 * whose action loads the bundled `@aiqadam/qadam-webhook` qadam and returns a response. The run
 * status the engine reports over the worker socket is what is asserted, not a mock.
 *
 * The two fork modes and the two isolate modes live in separate `describe`s with their own skip
 * conditions: only the isolate cases need the `isolate` binary and root, so a host without it runs
 * the fork cases instead of skipping the whole file (#709).
 *
 * Runs inside the privileged `test:sandbox-e2e` harness, which builds the engine and the qadam into
 * the image (`test/e2e/Dockerfile`).
 */

const BOX_ID = 1
const ISOLATE_BINARY_PATH = path.resolve(process.cwd(), 'packages/server/api/src/assets', getIsolateExecutableName())
const ENGINE_BUNDLE_PATH = path.resolve(process.cwd(), 'dist/packages/engine/main.js')
const WEBHOOK_QADAM_PACKAGE_JSON = path.resolve(process.cwd(), 'packages/qadams/core/webhook/dist/package.json')
const PROJECT_ID = 'proj-per-mode'
const PLATFORM_ID = 'plat-per-mode'
const RUN_ID = 'run-per-mode'
const LOGS_FILE_ID = 'logs-per-mode'
const FLOW_VERSION_ID = 'fv-per-mode'
const FILE_UPLOAD_PATH_PREFIX = '/api/v1/files/'

// Only the isolate modes need the binary and root; UNSANDBOXED and SANDBOX_CODE_ONLY take the fork
// path and must keep running on a host that merely lacks isolate.
const isolateSkip = requireLinuxPrivileged() ?? requireIsolateBinary(ISOLATE_BINARY_PATH)

const FORK_MODES = [
    ExecutionMode.UNSANDBOXED,
    ExecutionMode.SANDBOX_CODE_ONLY,
] as const

const ISOLATE_MODES = [
    ExecutionMode.SANDBOX_PROCESS,
    ExecutionMode.SANDBOX_CODE_AND_PROCESS,
] as const

// The file-API stub below answers only the engine's file uploads. Anything else is a route the
// engine did not use to hit during `EXECUTE_FLOW`, and the constant-200 stub this replaced would
// have answered it with a bogus `{ readUrl }` that nothing noticed. Record every request and fail
// the suite if one outside the allowlist appears.
const fileApiRequests: FileApiRequest[] = []

let fileApiServer: http.Server
let internalApiUrl: string
let builtQadamVersion: string

beforeAll(async () => {
    if (!existsSync(ENGINE_BUNDLE_PATH)) {
        throw new Error(
            `precondition failed: ${ENGINE_BUNDLE_PATH} is not built. The sandbox e2e image builds ` +
            '@aiqadam/engine; run the suite via `npm run test:sandbox-e2e`.',
        )
    }
    if (!existsSync(WEBHOOK_QADAM_PACKAGE_JSON)) {
        throw new Error(
            `precondition failed: ${WEBHOOK_QADAM_PACKAGE_JSON} is not built. The sandbox e2e image builds ` +
            '@aiqadam/qadam-webhook; run the suite via `npm run test:sandbox-e2e`.',
        )
    }

    // `createSandboxForJob` resolves the engine through `getEnginePath()` = cache/<version>/common/main.js,
    // which the worker's engine installer normally populates from the built bundle. Seed the same
    // cache the worker would, so the test runs the exact engine the worker ships.
    await mkdir(getGlobalCacheCommonPath(), { recursive: true })
    await mkdir(getGlobalCodeCachePath(), { recursive: true })
    await cp(ENGINE_BUNDLE_PATH, path.join(getGlobalCacheCommonPath(), 'main.js'))
    await cp(`${ENGINE_BUNDLE_PATH}.map`, path.join(getGlobalCacheCommonPath(), 'main.js.map'))

    builtQadamVersion = (JSON.parse(await readFile(WEBHOOK_QADAM_PACKAGE_JSON, 'utf8')) as { version: string }).version

    fileApiServer = http.createServer(handleFileApiRequest)
    await new Promise<void>((resolve) => fileApiServer.listen(0, '127.0.0.1', () => resolve()))
    const address = fileApiServer.address()
    if (typeof address === 'string' || address === null) {
        throw new Error('file API stub did not bind a TCP port')
    }
    internalApiUrl = `http://127.0.0.1:${address.port}/api/`
}, 60_000)

afterAll(async () => {
    if (fileApiServer) {
        await new Promise<void>((resolve, reject) => fileApiServer.close((err) => (err ? reject(err) : resolve())))
    }
    // `workerSettings` is a module-level singleton and the e2e config runs every spec in one process
    // (`isolate: false`), so a later spec that reads `getSettings()` would otherwise inherit the last
    // mode's allow-list. Restore a neutral value instead of leaving the last case's settings behind.
    workerSettings.set(workerSettingsFor(ExecutionMode.UNSANDBOXED))
})

describe('execution modes — fork path', () => {
    it.each(FORK_MODES)('%s: boots the sandbox and completes a basic flow', async (mode) => {
        await runMode(mode)
    }, 120_000)
})

describe.skipIf(isolateSkip)('execution modes — isolate path', () => {
    // The worker's boot preflight (#709), against the real `isolate` binary, is what turns an
    // unprivileged isolate deployment into a loud startup failure. The unit suite mocks the spawn;
    // this is the only place the actual probe command runs before merge.
    it('passes the boot preflight against the real isolate binary', async () => {
        await isolatePreflight.assertRunnable({ executionMode: ExecutionMode.SANDBOX_PROCESS, log: silentLogger() })
    }, 30_000)

    it.each(ISOLATE_MODES)('%s: boots the sandbox and completes a basic flow', async (mode) => {
        await runMode(mode)
    }, 120_000)
})

async function runMode(mode: ExecutionMode): Promise<void> {
    fileApiRequests.length = 0
    workerSettings.set(workerSettingsFor(mode))
    const log = silentLogger()
    const runLogStatuses: FlowRunStatus[] = []
    const apiClient = inProcessApiClient.create({
        uploadRunLog: (input) => {
            const status = (input as { status: FlowRunStatus }).status
            runLogStatuses.push(status)
            return { status, logsFileId: LOGS_FILE_ID }
        },
        updateRunProgress: () => undefined,
        updateStepProgress: () => undefined,
        sendFlowResponse: () => undefined,
    })
    const jobContext = makeJobContext()
    const sandbox = createSandboxForJob({
        log,
        apiClient,
        boxId: BOX_ID,
        reusable: false,
        proxyPort: null,
        getCurrentJobContext: () => jobContext,
    })

    try {
        await sandbox.start({ flowVersionId: FLOW_VERSION_ID, platformId: PLATFORM_ID, mounts: [] })

        const result = await sandbox.execute(
            EngineOperationType.EXECUTE_FLOW,
            makeBeginOperation({ internalApiUrl, qadamVersion: builtQadamVersion }),
            { timeoutInSeconds: 90 },
        )

        expect(result.status, `engine error: ${result.error ?? '(none)'}\nlogs:\n${result.logs ?? ''}`).toBe(EngineResponseStatus.OK)
        expect(runLogStatuses).toContain(FlowRunStatus.SUCCEEDED)

        // Every engine HTTP call the run made must be a file upload. Asserted per mode so a regression
        // names the mode that introduced an unexpected call.
        const unexpected = fileApiRequests.filter((request) => !isExpectedFileApiRequest(request))
        expect(unexpected, `unexpected internal API calls during ${mode}`).toEqual([])
    }
    finally {
        await sandbox.shutdown()
    }
}

function handleFileApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Drain the body even though the stub ignores it: an unconsumed request body would keep the
    // connection busy and can stall the engine's upload.
    req.resume()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    fileApiRequests.push({ method: req.method ?? 'GET', path: url.pathname })

    if (isExpectedFileApiRequest({ method: req.method ?? 'GET', path: url.pathname })) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ readUrl: 'http://127.0.0.1/read' }))
        return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unexpected internal API request' }))
}

function isExpectedFileApiRequest({ method, path: requestPath }: FileApiRequest): boolean {
    return method === 'PUT' && requestPath.startsWith(FILE_UPLOAD_PATH_PREFIX)
}

function workerSettingsFor(mode: string): WorkerSettingsResponse {
    return {
        PUBLIC_URL: 'http://localhost:4200/',
        TRIGGER_TIMEOUT_SECONDS: 60,
        TRIGGER_HOOKS_TIMEOUT_SECONDS: 60,
        PAUSED_FLOW_TIMEOUT_DAYS: 30,
        EXECUTION_MODE: mode,
        FLOW_TIMEOUT_SECONDS: 600,
        LOG_LEVEL: 'silent',
        LOG_PRETTY: 'false',
        ENVIRONMENT: 'test',
        APP_WEBHOOK_SECRETS: '',
        MAX_FLOW_RUN_LOG_SIZE_MB: 10,
        MAX_FILE_SIZE_MB: 10,
        SANDBOX_MEMORY_LIMIT: '1048576',
        SANDBOX_PROPAGATED_ENV_VARS: [],
        DEV_QADAMS: [],
        OFFICIAL_QADAMS_INSTALL_ENABLED: false,
        OTEL_ENABLED: false,
        FILE_STORAGE_LOCATION: 'db',
        S3_USE_SIGNED_URLS: 'false',
        EVENT_DESTINATION_TIMEOUT_SECONDS: 30,
        NETWORK_MODE: NetworkMode.UNRESTRICTED,
        SSRF_ALLOW_LIST: ['127.0.0.1'],
    }
}

function makeJobContext(): SandboxJobContext {
    return {
        runId: RUN_ID,
        projectId: PROJECT_ID,
        platformId: PLATFORM_ID,
        environment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
    }
}

function makeBeginOperation({ internalApiUrl, qadamVersion }: { internalApiUrl: string, qadamVersion: string }): BeginExecuteFlowOperation {
    return {
        projectId: PROJECT_ID,
        engineToken: 'e2e-engine-token',
        internalApiUrl,
        publicApiUrl: 'http://localhost:4200/api/',
        timeoutInSeconds: 90,
        platformId: PLATFORM_ID,
        flowVersion: makeFlowVersion({ qadamVersion }),
        flowRunId: RUN_ID,
        executionType: ExecutionType.BEGIN,
        runEnvironment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: null,
        triggerPayload: { type: 'inline', value: {} },
        executeTrigger: false,
        logsFileId: LOGS_FILE_ID,
    }
}

// A bundled-qadam trigger plus a bundled-qadam action: `executeTrigger: false` keeps the trigger
// from reaching out, but the engine still loads `@aiqadam/qadam-webhook` for both steps — the
// resolution that used to fail in isolate modes (#375).
function makeFlowVersion({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    const returnResponse: FlowAction = {
        name: 'step_1',
        displayName: 'Return Response',
        valid: true,
        skip: false,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowActionType.PIECE,
        settings: {
            qadamName: '@aiqadam/qadam-webhook',
            qadamVersion,
            actionName: 'return_response',
            input: {
                responseType: 'json',
                fields: { body: { ok: true } },
                respond: 'stop',
            },
            propertySettings: {},
        },
    }
    const trigger: FlowTrigger = {
        name: 'trigger_1',
        displayName: 'Catch Webhook',
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowTriggerType.PIECE,
        settings: {
            qadamName: '@aiqadam/qadam-webhook',
            qadamVersion,
            triggerName: 'catch_webhook',
            input: { authType: 'none' },
            propertySettings: {},
        },
        nextAction: returnResponse,
    }
    return {
        id: FLOW_VERSION_ID,
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-per-mode',
        displayName: 'Per-mode flow',
        trigger,
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
        localeSource: null,
    }
}

type FileApiRequest = {
    method: string
    path: string
}
