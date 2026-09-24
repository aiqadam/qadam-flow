import {
    ExecutionType,
    FlowActionType,
    FlowRunStatus,
    FlowTriggerType,
    FlowVersionState,
    LoopCheckpointReason,
    LoopExecutionMode,
    LoopOnItemsAction,
    ResumeReason,
    RunEnvironment,
    StepOutput,
    StreamStepProgress,
} from '@aiqadam/shared'
import type { BeginExecuteFlowOperation, FlowVersion, ResumeExecuteFlowOperation } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'

const { mockSendUpdate } = vi.hoisted(() => ({
    mockSendUpdate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/helper/flow-run-progress-reporter', () => ({
    flowRunProgressReporter: {
        sendUpdate: mockSendUpdate,
        backup: vi.fn().mockResolvedValue(undefined),
        createOutputContext: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(undefined) }),
    },
}))

const { mockDownload } = vi.hoisted(() => ({
    mockDownload: vi.fn(),
}))
vi.mock('../../src/lib/engine-file-api', () => ({
    engineFileApi: {
        download: mockDownload,
        upload: vi.fn(),
    },
}))

vi.mock('../../src/lib/helper/trigger-helper', () => ({
    triggerHelper: {
        executeTrigger: vi.fn(),
        executeOnStart: vi.fn().mockResolvedValue(undefined),
    },
}))

vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({ sendFlowResponse: vi.fn().mockResolvedValue(undefined) }),
    },
}))

const { mockCreateWaitpoint } = vi.hoisted(() => ({
    mockCreateWaitpoint: vi.fn(),
}))
vi.mock('../../src/lib/qadam-context/waitpoint-client', () => ({
    waitpointClient: {
        create: mockCreateWaitpoint,
    },
}))

import { flowOperation } from '../../src/lib/operations/flow.operation'

// #387: a durable loop's checkpoints through the real persistence round trip — the journal the
// engine reports is serialized as the run log, and each RESUME restores it from there exactly as a
// resumed job does, rather than from a hand-built context.
describe('durable loop across RESUME operations', () => {
    it('checkpoints on a long rate-limit spacing and finishes every item exactly once across resumes', async () => {
        mockSendUpdate.mockClear()
        mockCreateWaitpoint.mockReset()
        mockCreateWaitpoint.mockResolvedValue({ id: 'wp', resumeUrl: 'http://localhost:3000/v1/flow-runs/run-1/waitpoints/wp' })

        const flowVersion = flowVersionWithLoop()
        await flowOperation.execute(beginOperation({ flowVersion }))
        let executions = 1
        while (lastReported().status === FlowRunStatus.PAUSED) {
            mockDownload.mockResolvedValueOnce(new TextEncoder().encode(JSON.stringify({ executionState: { steps: lastReported().steps, tags: [] } })))
            await flowOperation.execute(resumeOperation({ flowVersion }))
            executions += 1
        }

        const loop = lastReported().steps.loop
        expect(executions).toBe(3)
        expect(lastReported().status).toBe(FlowRunStatus.SUCCEEDED)
        expect(loop?.type === FlowActionType.LOOP_ON_ITEMS ? loop.output?.collected : undefined).toEqual([0, 1, 2])
        expect(loop?.type === FlowActionType.LOOP_ON_ITEMS ? loop.output?.checkpoint : undefined).toMatchObject({ count: 2, reason: LoopCheckpointReason.RATE_LIMIT, itemsCount: 3 })
        expect(mockCreateWaitpoint).toHaveBeenCalledTimes(2)
        for (const [request] of mockCreateWaitpoint.mock.calls) {
            expect(request).toMatchObject({ type: 'DELAY', stepName: 'loop' })
            // The resume is scheduled for when the limiter would start the next item, not at once.
            expect(Date.parse(request.resumeDateTime) - Date.now()).toBeGreaterThan(100_000)
        }
    }, 30000)
})

function lastReported(): { status: FlowRunStatus, steps: Record<string, StepOutput> } {
    const call = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
    return { status: call.flowExecutorContext.verdict.status, steps: call.flowExecutorContext.steps }
}

function flowVersionWithLoop(): FlowVersion {
    const loop: LoopOnItemsAction = {
        name: 'loop',
        displayName: 'Loop',
        type: FlowActionType.LOOP_ON_ITEMS,
        skip: false,
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        settings: {
            items: '{{ [0, 1, 2] }}',
            collect: { value: '{{ loop.output.item }}' },
            execution: { mode: LoopExecutionMode.SEQUENTIAL, durable: true, rateLimit: { count: 1, perSeconds: 120 } },
        },
    }
    return {
        id: 'fv-1',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-1',
        displayName: 'Durable Loop Flow',
        trigger: {
            name: 'trigger_1',
            valid: true,
            displayName: 'Test Trigger',
            type: FlowTriggerType.EMPTY,
            settings: {},
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            nextAction: loop,
        },
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
}

function beginOperation({ flowVersion }: { flowVersion: FlowVersion }): BeginExecuteFlowOperation {
    return {
        ...commonOperationFields({ flowVersion }),
        executionType: ExecutionType.BEGIN,
        triggerPayload: { type: 'inline', value: {} },
        executeTrigger: false,
    }
}

function resumeOperation({ flowVersion }: { flowVersion: FlowVersion }): ResumeExecuteFlowOperation {
    return {
        ...commonOperationFields({ flowVersion }),
        executionType: ExecutionType.RESUME,
        resumePayload: { type: 'inline', value: {} },
        resumeReason: ResumeReason.WAITPOINT,
        logsFileId: 'logs-file-1',
    }
}

function commonOperationFields({ flowVersion }: { flowVersion: FlowVersion }) {
    return {
        projectId: 'proj-1',
        engineToken: 'test-token',
        internalApiUrl: 'http://localhost:3000/',
        publicApiUrl: 'http://localhost:4200/api/',
        timeoutInSeconds: 600,
        platformId: 'plat-1',
        flowVersion,
        flowRunId: 'run-1',
        runEnvironment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: null,
    }
}
