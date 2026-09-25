import { createServer, Server } from 'http'
import { promisify } from 'util'
import { zstdDecompress as zstdDecompressCallback } from 'zlib'
import { FlowRunStatus, FlowTriggerType, FlowVersionState, ResolveInlineFlowResult, RunEnvironment, StreamStepProgress } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { callFlowInline } from '../../src/lib/handler/inline-flow-executor'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { buildQadamAction } from './test-helper'

const zstdDecompress = promisify(zstdDecompressCallback)

const { mockUploadRunLog, mockResolveInlineFlow, mockUploadLogFile } = vi.hoisted(() => ({
    mockUploadRunLog: vi.fn().mockResolvedValue(undefined),
    mockResolveInlineFlow: vi.fn(),
    mockUploadLogFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({
            uploadRunLog: mockUploadRunLog,
            resolveInlineFlow: mockResolveInlineFlow,
        }),
    },
}))

vi.mock('../../src/lib/engine-file-api', () => ({
    engineFileApi: {
        download: vi.fn(),
        upload: mockUploadLogFile,
    },
}))

vi.mock('../../src/lib/helper/flow-run-progress-reporter', () => ({
    flowRunProgressReporter: {
        sendUpdate: vi.fn().mockResolvedValue(undefined),
        backup: vi.fn().mockResolvedValue(undefined),
        createOutputContext: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(undefined) }),
    },
}))

vi.mock('../../src/lib/helper/trigger-helper', () => ({
    triggerHelper: {
        executeTrigger: vi.fn(),
        executeOnStart: vi.fn().mockResolvedValue(undefined),
    },
}))

const TRANSLATIONS = {
    translations: [
        { key: 'greeting', values: { en: 'Hello', ru: 'Привет' } },
    ],
}
const PROJECT = { defaultLocale: 'en' }

let server: Server
let apiUrl: string

beforeAll(async () => {
    server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/v1/worker/translations') {
            res.end(JSON.stringify(TRANSLATIONS))
            return
        }
        if (req.url === '/v1/worker/project') {
            res.end(JSON.stringify(PROJECT))
            return
        }
        res.statusCode = 404
        res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('mock server failed to bind to a TCP port')
    }
    apiUrl = `http://127.0.0.1:${address.port}/`
})

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

function buildParentConstants(): EngineConstants {
    return new EngineConstants({
        flowId: 'PARENT_FLOW_ID',
        flowVersionId: 'PARENT_FLOW_VERSION_ID',
        flowVersionState: FlowVersionState.LOCKED,
        triggerQadamName: 'trigger',
        flowRunId: 'PARENT_FLOW_RUN_ID',
        publicApiUrl: 'http://127.0.0.1:1/api/',
        internalApiUrl: apiUrl,
        retryConstants: { maxAttempts: 1, retryExponential: 2, retryInterval: 1 },
        engineToken: 'WORKER_TOKEN',
        projectId: 'PROJECT_ID',
        streamStepProgress: StreamStepProgress.NONE,
        workerHandlerId: null,
        httpRequestId: null,
        platformId: 'PLATFORM_ID',
        runEnvironment: RunEnvironment.TESTING,
        stepNames: ['trigger', 'step_1'],
        // References the very step run before the inline callFlow dispatch below — only
        // resolvable once step_1 has actually run, exactly like the queued-path laziness test.
        flowVersionLocaleSource: '{{step_1[\'output\'].lang}}',
    })
}

describe('inline callFlow inherits the parent\'s real, in-flight execution state, not an empty one', () => {
    it('resolves the child\'s $t against the parent\'s inherited locale, computed from step_1\'s real output', async () => {
        const parentConstants = buildParentConstants()

        const afterStep1 = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_1',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { lang: 'ru' } },
            }),
            executionState: FlowExecutorContext.empty(),
            constants: parentConstants,
        })
        expect(afterStep1.steps.step_1.output).toEqual({ lang: 'ru' })

        mockResolveInlineFlow.mockResolvedValue({
            ok: true,
            childRunId: 'CHILD_RUN_ID',
            childLogsFileId: 'CHILD_LOGS_FILE_ID',
            inlineDepth: 1,
            flowVersion: {
                id: 'CHILD_FLOW_VERSION_ID',
                flowId: 'CHILD_FLOW_ID',
                displayName: 'Child Flow',
                updatedBy: null,
                valid: true,
                schemaVersion: null,
                agentIds: [],
                state: FlowVersionState.LOCKED,
                connectionIds: [],
                backupFiles: null,
                notes: [],
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
                // No override of its own — the child's $t must fall back to whatever locale it
                // inherited from the parent.
                localeSource: null,
                trigger: {
                    name: 'trigger',
                    displayName: 'Trigger',
                    valid: true,
                    lastUpdatedDate: new Date().toISOString(),
                    type: FlowTriggerType.EMPTY,
                    settings: {},
                    nextAction: buildQadamAction({
                        name: 'child_step_1',
                        qadamName: '@aiqadam/qadam-data-mapper',
                        actionName: 'advanced_mapping',
                        input: { mapping: { key: '{{$t[\'greeting\']}}' } },
                    }),
                },
            },
        } satisfies ResolveInlineFlowResult)

        const result = await callFlowInline({
            constants: parentConstants,
            executionState: afterStep1,
            flowId: 'CHILD_FLOW_ID',
            payload: {},
            insideConcurrentIteration: false,
        })

        expect(result.status).toBe('success')
        expect(mockUploadRunLog).toHaveBeenCalledWith(expect.objectContaining({
            status: FlowRunStatus.SUCCEEDED,
        }))

        // The child's own log is the only place its step output surfaces — decompress and parse it
        // to prove the $t inside the child actually resolved against the parent's real 'ru' locale,
        // not silently against the project's 'en' default (which an empty execution state, resolving
        // the parent's own localeSource against no step outputs, would have fallen through to).
        expect(mockUploadLogFile).toHaveBeenCalledTimes(1)
        const uploadedData = mockUploadLogFile.mock.calls[0][0].data
        const decompressed = await zstdDecompress(uploadedData)
        const log = JSON.parse(decompressed.toString('utf8')) as { executionState: { steps: Record<string, { output: unknown }> } }
        expect(log.executionState.steps.child_step_1.output).toEqual({ key: 'Привет' })
    })
})
