import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress as zstdDecompressCallback } from 'node:zlib'
import { EngineOperationType, EngineResponseStatus, ExecutionMode, ExecutionType, FileType, FlowActionType, FlowRunStatus, FlowTriggerType, FlowVersionState, isNil, NetworkMode, RunEnvironment, StepOutputStatus, StreamStepProgress, tryCatch } from '@aiqadam/shared'
import type { BeginExecuteFlowOperation, CodeAction, FlowAction, FlowTrigger, FlowVersion, WorkerSettingsResponse } from '@aiqadam/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getGlobalCacheCommonPath, getGlobalCodeCachePath } from '../../src/lib/cache/cache-paths'
import { workerSettings } from '../../src/lib/config/worker-settings'
import { startEgressStack } from '../../src/lib/egress/lifecycle'
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
 * whose actions load the bundled `@aiqadam/qadam-webhook` qadam, run a CODE step and return a
 * response. The run status the engine reports over the worker socket is what is asserted, not a mock.
 *
 * Two follow-ups from #709 are covered here, and each mode runs under both network modes:
 *
 *   - #711: the worker's real egress stack (`startEgressStack`, the exact call `worker.ts` makes at
 *     boot) is started per case, so `STRICT` arms the production proxy and — for the isolate modes —
 *     the kernel iptables lockdown while a flow runs. The engine's file uploads are asserted to be
 *     the only internal API calls that survive, per mode and per network mode.
 *   - #712: the CODE step's artifact reports `typeof require`, which the engine evaluates through
 *     isolated-vm in the V8 modes and through the no-op runner in the fork modes. The boundary —
 *     V8 has no `require`, the fork does — is read back from the uploaded run log.
 *
 * The two fork modes and the two isolate modes live in separate `describe`s with their own skip
 * conditions: only the isolate cases need the `isolate` binary and root, so a host without it runs
 * the fork cases instead of skipping the whole file (#709).
 *
 * Runs inside the privileged `test:sandbox-e2e` harness, which builds the engine and the qadam into
 * the image (`test/e2e/Dockerfile`).
 */

const zstdDecompress = promisify(zstdDecompressCallback)

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
const FILE_TYPE_HEADER = 'x-ap-file-type'
const CODE_STEP_NAME = 'step_code'

// The CODE step's artifact. It is written to the code cache the worker mounts into the sandbox, and
// the engine executes it either through isolated-vm (`SANDBOX_CODE_ONLY`, `SANDBOX_CODE_AND_PROCESS`)
// or the no-op runner (`UNSANDBOXED`, `SANDBOX_PROCESS`). `require` is defined in the no-op runner's
// child and absent inside the V8 isolate — that difference is the boundary #712 pins.
const CODE_ARTIFACT_SOURCE = 'module.exports.code = () => ({ require: typeof require })\n'

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

const NETWORK_MODES = [
    NetworkMode.UNRESTRICTED,
    NetworkMode.STRICT,
] as const

// #711: every execution mode runs under both network modes, so STRICT is exercised against the fork
// and the isolate process paths alike, not only SANDBOX_PROCESS (which `sandbox-real-third-party`
// already covers against real third-party hosts).
const FORK_CASES: ModeCase[] = FORK_MODES.flatMap((mode) => NETWORK_MODES.map((networkMode) => ({
    mode,
    networkMode,
    codeRunsInV8: mode === ExecutionMode.SANDBOX_CODE_ONLY,
})))

const ISOLATE_CASES: ModeCase[] = ISOLATE_MODES.flatMap((mode) => NETWORK_MODES.map((networkMode) => ({
    mode,
    networkMode,
    codeRunsInV8: mode === ExecutionMode.SANDBOX_CODE_AND_PROCESS,
})))

// The file-API stub below answers only the engine's file uploads. Anything else is a route the
// engine did not use to hit during `EXECUTE_FLOW`, and the constant-200 stub this replaced would
// have answered it with a bogus `{ readUrl }` that nothing noticed. Record every request and fail
// the suite if one outside the allowlist appears.
const fileApiRequests: FileApiRequest[] = []

// The FLOW_RUN_LOG upload bodies, zstd-compressed JSON manifests. Their `executionState.steps` is
// where the CODE step's output lands (#712).
const runLogUploads: Buffer[] = []

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

    // The CODE step artifact, at the path the engine reads from in both process paths
    // (`${baseCodeDirectory}/${flowVersionId}/${stepName}/index.js`).
    const codeArtifactDir = path.join(getGlobalCodeCachePath(), FLOW_VERSION_ID, CODE_STEP_NAME)
    await mkdir(codeArtifactDir, { recursive: true })
    await writeFile(path.join(codeArtifactDir, 'index.js'), CODE_ARTIFACT_SOURCE, 'utf8')

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
    workerSettings.set(workerSettingsFor({ mode: ExecutionMode.UNSANDBOXED, networkMode: NetworkMode.UNRESTRICTED }))
})

describe('execution modes — fork path', () => {
    it.each(FORK_CASES)('$mode + $networkMode: boots the sandbox and completes a flow with a CODE step', async (testCase) => {
        await runMode(testCase)
    }, 120_000)
})

describe.skipIf(isolateSkip)('execution modes — isolate path', () => {
    // The worker's boot preflight (#709), against the real `isolate` binary, is what turns an
    // unprivileged isolate deployment into a loud startup failure. The unit suite mocks the spawn;
    // this is the only place the actual probe command runs before merge.
    it('passes the boot preflight against the real isolate binary', async () => {
        await isolatePreflight.assertRunnable({ executionMode: ExecutionMode.SANDBOX_PROCESS, log: silentLogger() })
    }, 30_000)

    it.each(ISOLATE_CASES)('$mode + $networkMode: boots the sandbox and completes a flow with a CODE step', async (testCase) => {
        await runMode(testCase)
    }, 120_000)
})

async function runMode({ mode, networkMode, codeRunsInV8 }: ModeCase): Promise<void> {
    fileApiRequests.length = 0
    runLogUploads.length = 0
    workerSettings.set(workerSettingsFor({ mode, networkMode }))
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
    // Boot the worker's real egress stack for this network mode — the same call `worker.ts` makes at
    // startup — so under STRICT the sandbox's proxy URL and, for isolate modes, the kernel lockdown
    // are the production ones (#711).
    const egressStack = await startEgressStack({ log, apiUrl: internalApiUrl })
    try {
        const sandbox = createSandboxForJob({
            log,
            apiClient,
            boxId: BOX_ID,
            reusable: false,
            proxyPort: egressStack.proxyPort,
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

            // #712: the CODE step ran, and whether it saw `require` is the mode's actual boundary — absent
            // inside the V8 isolate, present in the no-op runner's forked child.
            expect(
                await readCodeStepOutput(),
                `CODE step output for ${mode} + ${networkMode}`,
            ).toMatchObject({ require: codeRunsInV8 ? 'undefined' : 'function' })

            // Every engine HTTP call the run made must be a file upload. Asserted per mode so a regression
            // names the mode that introduced an unexpected call.
            const unexpected = fileApiRequests.filter((request) => !isExpectedFileApiRequest(request))
            expect(unexpected, `unexpected internal API calls during ${mode} + ${networkMode}`).toEqual([])
        }
        finally {
            await sandbox.shutdown()
        }
    }
    finally {
        // Outer `finally` so a factory or sandbox-shutdown failure still tears the egress stack down:
        // under STRICT its proxy (and the isolate iptables chain) must not leak into the next case.
        await egressStack.shutdown()
    }
}

// The engine uploads the whole run log (a zstd-compressed JSON manifest) to the file API, and the
// periodic flush loop means the CODE step's output may land in any of those bodies. Read them back
// rather than mocking the engine's reporting (#712). The final flush can trail the RPC result by a
// beat, so this waits briefly for a body that carries the step.
async function readCodeStepOutput(): Promise<unknown> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        // Newest first: a periodic flush can land while the step is still RUNNING, and that manifest
        // omits `output` (JSON drops undefined), so only the SUCCEEDED snapshot is the answer.
        for (const body of [...runLogUploads].reverse()) {
            const { data } = await tryCatch(async () => JSON.parse((await zstdDecompress(body)).toString('utf8')) as RunLogManifest)
            if (isNil(data)) continue
            const step = data.executionState?.steps?.[CODE_STEP_NAME]
            if (!isNil(step) && step.status === StepOutputStatus.SUCCEEDED) return step.output
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('no captured FLOW_RUN_LOG upload carried a SUCCEEDED CODE step output')
}

function handleFileApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    // Respond only once the body is drained: the FLOW_RUN_LOG upload is read back by the suite
    // (#712), and an unconsumed body can stall the engine's next upload.
    req.on('end', () => {
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        fileApiRequests.push({ method, path: url.pathname })

        if (isExpectedFileApiRequest({ method, path: url.pathname })) {
            if (req.headers[FILE_TYPE_HEADER] === FileType.FLOW_RUN_LOG) {
                runLogUploads.push(Buffer.concat(chunks))
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ readUrl: 'http://127.0.0.1/read' }))
            return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unexpected internal API request' }))
    })
}

function isExpectedFileApiRequest({ method, path: requestPath }: FileApiRequest): boolean {
    return method === 'PUT' && requestPath.startsWith(FILE_UPLOAD_PATH_PREFIX)
}

function workerSettingsFor({ mode, networkMode }: { mode: string, networkMode: NetworkMode }): WorkerSettingsResponse {
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
        NETWORK_MODE: networkMode,
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

// A bundled-qadam trigger, a CODE step that probes `require`, and a bundled-qadam action:
// `executeTrigger: false` keeps the trigger from reaching out, but the engine still loads
// `@aiqadam/qadam-webhook` for the trigger and the final action — the resolution that used to fail
// in isolate modes (#375) — while the CODE step pins the V8 boundary per mode (#712).
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
    const code: CodeAction = {
        name: CODE_STEP_NAME,
        displayName: 'Run Code',
        valid: true,
        skip: false,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowActionType.CODE,
        settings: {
            sourceCode: {
                packageJson: '{}',
                code: CODE_ARTIFACT_SOURCE,
            },
            input: {},
        },
        nextAction: returnResponse,
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
        nextAction: code,
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

type ModeCase = {
    mode: ExecutionMode
    networkMode: NetworkMode
    codeRunsInV8: boolean
}

type RunLogManifest = {
    executionState?: {
        steps?: Record<string, CodeStepLog>
    }
}

type CodeStepLog = {
    status?: string
    output?: unknown
}

type FileApiRequest = {
    method: string
    path: string
}
