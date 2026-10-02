import { AgentQadamTool, AgentToolType, DEFAULT_MCP_DATA, ExecutionToolStatus, FieldControlMode, FlowTriggerType, FlowVersionState, ResolveInlineFlowRequest, ResolveInlineFlowResult, RunEnvironment, UploadRunLogsRequest } from '@aiqadam/shared'
import { LanguageModel } from 'ai'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockResolveInlineFlow, mockUploadRunLog, mockUpdateRunProgress, mockUpdateStepProgress } = vi.hoisted(() => ({
    mockResolveInlineFlow: vi.fn<(request: ResolveInlineFlowRequest) => Promise<ResolveInlineFlowResult>>(),
    mockUploadRunLog: vi.fn<(request: UploadRunLogsRequest) => Promise<void>>(async () => undefined),
    mockUpdateRunProgress: vi.fn(async () => undefined),
    mockUpdateStepProgress: vi.fn(async () => undefined),
}))
vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({
            resolveInlineFlow: mockResolveInlineFlow,
            uploadRunLog: mockUploadRunLog,
            updateRunProgress: mockUpdateRunProgress,
            updateStepProgress: mockUpdateStepProgress,
        }),
    },
}))

vi.mock('../../src/lib/engine-file-api', () => ({
    engineFileApi: {
        download: vi.fn(),
        upload: vi.fn().mockResolvedValue(undefined),
    },
}))

vi.mock('../../src/lib/helper/trigger-helper', () => ({
    triggerHelper: {
        executeTrigger: vi.fn(),
        executeOnStart: vi.fn().mockResolvedValue(undefined),
    },
}))

import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { flowRunProgressReporter } from '../../src/lib/helper/flow-run-progress-reporter'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { agentTools } from '../../src/lib/tools'
import { mockHttpServer } from '../handler/mock-http-server'
import { buildQadamAction, generateMockEngineConstants } from '../handler/test-helper'

// What the worker's `runScope.assertOwnsRun` admits for `resolveInlineFlow`: the job's own run.
const JOB_RUN_ID = 'job-run-id'

// #643: an agent's PIECE tool used to execute with the MCP placeholder run id, so an inline Call
// Flow from it asked the worker for a child of a run the job does not own, and was refused.
describe('an agent PIECE tool calling @aiqadam/qadam-subflows callFlow', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    beforeEach(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        mockServer.requests.length = 0
        mockResolveInlineFlow.mockReset()
        mockResolveInlineFlow.mockImplementation(async ({ parentRunId }) => {
            if (parentRunId !== JOB_RUN_ID) {
                throw new Error('resolveInlineFlow refused: the engine asked for a run outside the current job')
            }
            return childFlow({ childStepInput: { mapping: { answer: 42 } } })
        })
        mockUploadRunLog.mockClear()
        mockUpdateRunProgress.mockClear()
        mockUpdateStepProgress.mockClear()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await flowRunProgressReporter.shutdown()
    })

    const parentConstants = (): EngineConstants => generateMockEngineConstants({
        flowId: 'parent-flow-id',
        flowVersionId: 'parent-flow-version-id',
        flowRunId: JOB_RUN_ID,
        runEnvironment: RunEnvironment.PRODUCTION,
        internalApiUrl: `${mockServer.baseUrl}/`,
        logsFileId: 'parent-logs-file-id',
    })

    const runCallFlowTool = async ({ executionMode, waitForResponse }: { executionMode: 'inline' | 'queue', waitForResponse: boolean }) => {
        const tools = await agentTools.tools({
            engineConstants: parentConstants(),
            insideConcurrentIteration: false,
            tools: [callFlowTool({ executionMode, waitForResponse })],
            model: {} as LanguageModel,
        })
        return tools.call_flow.execute!({ instruction: 'call the child flow' }, {} as never)
    }

    it('starts the inline child under the job\'s own run and returns its result to the agent', async () => {
        const result = await runCallFlowTool({ executionMode: 'inline', waitForResponse: true })

        expect(result.errorMessage).toBeUndefined()
        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(result.output).toEqual({ status: 'success', data: undefined })
        expect(mockResolveInlineFlow).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'child-flow', parentRunId: JOB_RUN_ID }))
        expect(mockUploadRunLog).toHaveBeenCalledWith(expect.objectContaining({ runId: 'child-run-id', status: 'SUCCEEDED' }))
    }, 20000)

    it('returns a failed inline child to the agent as a tool error, and reports nothing for the parent run', async () => {
        mockResolveInlineFlow.mockResolvedValue(childFlow({ childStepInput: { mapping: 'not json {' } }))

        const result = await runCallFlowTool({ executionMode: 'inline', waitForResponse: true })

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('mapping')
        expect(mockUploadRunLog.mock.calls.map(([request]) => [request.runId, request.status])).toEqual([['child-run-id', 'FAILED']])
        expect(mockUpdateRunProgress).not.toHaveBeenCalled()
        // The tool's own step never became the run's snapshot, so the final flush has nothing to send.
        await flowRunProgressReporter.backup()
        expect(mockUploadRunLog).toHaveBeenCalledTimes(1)
    }, 20000)

    it('refuses a Queue-mode call that waits for its response before creating a waitpoint or starting the child', async () => {
        const create = vi.spyOn(waitpointClient, 'create')

        const result = await runCallFlowTool({ executionMode: 'queue', waitForResponse: true })

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('which an agent tool cannot do')
        expect(create).not.toHaveBeenCalled()
        expect(mockServer.requests.filter((request) => request.path.startsWith('/v1/webhooks/'))).toEqual([])
    }, 20000)

    it('links a fire-and-forget Queue-mode child to the real run without letting it fail that run', async () => {
        const result = await runCallFlowTool({ executionMode: 'queue', waitForResponse: false })

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        const dispatched = mockServer.requests.filter((request) => request.path === '/v1/webhooks/child-flow')
        expect(dispatched).toHaveLength(1)
        expect(dispatched[0].headers['ap-parent-run-id']).toBe(JOB_RUN_ID)
        expect(dispatched[0].headers['ap-fail-parent-on-failure']).toBe('false')
    }, 20000)
})

describe('an agent PIECE tool whose action always pauses', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('is refused before the action runs, so nothing is left waiting on the parent run', async () => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        const create = vi.spyOn(waitpointClient, 'create')
        const tools = await agentTools.tools({
            engineConstants: generateMockEngineConstants({ flowRunId: JOB_RUN_ID }),
            insideConcurrentIteration: false,
            tools: [{
                type: AgentToolType.PIECE,
                toolName: 'wait',
                qadamMetadata: {
                    qadamName: '@aiqadam/qadam-approval',
                    qadamVersion: '1.0.0',
                    actionName: 'wait_for_approval',
                },
            }],
            model: {} as LanguageModel,
        })

        const result = await tools.wait.execute!({ instruction: 'wait for approval' }, {} as never)

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('which an agent tool cannot do')
        expect(create).not.toHaveBeenCalled()
    }, 20000)
})

describe('EngineConstants.fromAgentToolCall', () => {
    it('presents the parent step\'s real run, and keeps the flow placeholders a tool always had', () => {
        const parent = generateMockEngineConstants({
            flowId: 'parent-flow-id',
            flowVersionId: 'parent-flow-version-id',
            flowRunId: JOB_RUN_ID,
            runEnvironment: RunEnvironment.PRODUCTION,
            logsFileId: 'parent-logs-file-id',
            executionStartedAt: 1234,
        })

        const constants = EngineConstants.fromAgentToolCall({ parent, insideConcurrentIteration: true })

        expect(constants).toMatchObject({
            flowRunId: JOB_RUN_ID,
            runEnvironment: RunEnvironment.PRODUCTION,
            projectId: parent.projectId,
            platformId: parent.platformId,
            engineToken: parent.engineToken,
            executionStartedAt: 1234,
            insideConcurrentIteration: true,
            isAgentToolCall: true,
            isInlineChild: false,
            flowId: DEFAULT_MCP_DATA.flowId,
            flowVersionId: DEFAULT_MCP_DATA.flowVersionId,
            workerHandlerId: null,
            httpRequestId: null,
            logsFileId: undefined,
        })
    })
})

function callFlowTool({ executionMode, waitForResponse }: { executionMode: 'inline' | 'queue', waitForResponse: boolean }): AgentQadamTool {
    const chosen = (value: unknown) => ({ mode: FieldControlMode.CHOOSE_YOURSELF, value })
    return {
        type: AgentToolType.PIECE,
        toolName: 'call_flow',
        qadamMetadata: {
            qadamName: '@aiqadam/qadam-subflows',
            qadamVersion: '1.0.0',
            actionName: 'callFlow',
            predefinedInput: {
                fields: {
                    flow: chosen({ externalId: 'child', exampleData: {} }),
                    mode: chosen('simple'),
                    flowProps: chosen({ payload: { question: 'life' } }),
                    waitForResponse: chosen(waitForResponse),
                    executionMode: chosen(executionMode),
                },
            },
        },
    }
}

function childFlow({ childStepInput }: { childStepInput: Record<string, unknown> }): ResolveInlineFlowResult {
    return {
        ok: true,
        childRunId: 'child-run-id',
        childLogsFileId: 'child-logs-file-id',
        inlineDepth: 1,
        flowVersion: {
            id: 'child-flow-version-id',
            flowId: 'child-flow',
            displayName: 'Child',
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
            localeSource: null,
            trigger: {
                name: 'trigger',
                displayName: 'Trigger',
                valid: true,
                lastUpdatedDate: new Date().toISOString(),
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: buildQadamAction({
                    name: 'child_step',
                    qadamName: '@aiqadam/qadam-data-mapper',
                    actionName: 'advanced_mapping',
                    input: childStepInput,
                }),
            },
        },
    }
}
