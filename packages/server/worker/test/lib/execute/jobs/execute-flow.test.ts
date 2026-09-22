import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import {
    QadamFlowError,
    ErrorCode,
    EngineResponseStatus,
    ExecutionType,
    FlowActionType,
    FlowRunStatus,
    FlowTriggerType,
    FlowVersionState,
    StreamStepProgress,
    ResumeReason,
    RunEnvironment,
    WorkerJobType,
} from '@aiqadam/shared'
import type { ExecuteFlowJobData, FlowVersion } from '@aiqadam/shared'

const mockGetVersion = vi.fn()

vi.mock('../../../../src/lib/cache/flow/flow-cache', () => ({
    flowCache: () => ({
        getVersion: mockGetVersion,
    }),
}))

vi.mock('../../../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: vi.fn().mockReturnValue({ FLOW_TIMEOUT_SECONDS: 600 }),
    },
}))

vi.mock('../../../../src/lib/execute/utils/flow-helpers', () => ({
    provisionFlowPieces: vi.fn().mockResolvedValue({ provisioned: true }),
}))

import { executeFlowJob } from '../../../../src/lib/execute/jobs/execute-flow'
import { JobResultKind } from '../../../../src/lib/execute/types'
import { provisionFlowPieces } from '../../../../src/lib/execute/utils/flow-helpers'

const mockProvisionFlowPieces = vi.mocked(provisionFlowPieces)

function makeFlowVersion(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-1',
        displayName: 'Test Flow',
        trigger: {
            name: 'trigger_1',
            valid: true,
            displayName: 'Gmail Trigger',
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            type: FlowTriggerType.PIECE,
            settings: {
                qadamName: '@aiqadam/qadam-gmail',
                qadamVersion: '~0.1.0',
                triggerName: 'new_email',
                input: {},
                propertySettings: {},
            },
            nextAction: {
                name: 'step_1',
                valid: true,
                displayName: 'Slack Action',
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowActionType.PIECE,
                settings: {
                    qadamName: '@aiqadam/qadam-slack',
                    qadamVersion: '~0.2.0',
                    actionName: 'send_message',
                    input: {},
                    propertySettings: {},
                },
            },
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

function makeResumeJobData(overrides?: Partial<ExecuteFlowJobData>): ExecuteFlowJobData {
    return {
        projectId: 'proj-1',
        platformId: 'plat-1',
        jobType: WorkerJobType.EXECUTE_FLOW,
        environment: RunEnvironment.PRODUCTION,
        schemaVersion: 4,
        flowId: 'flow-1',
        flowVersionId: 'fv-1',
        runId: 'run-1',
        payload: { type: 'inline', value: {} },
        executionType: ExecutionType.RESUME,
        resumeReason: ResumeReason.WAITPOINT,
        streamStepProgress: StreamStepProgress.NONE,
        logsFileId: 'logs-file-1',
        ...overrides,
    }
}

function makeMockContext(apiOverrides?: Record<string, Mock>) {
    const mockSandbox = {
        start: vi.fn(),
        execute: vi.fn().mockResolvedValue({ status: 'OK' }),
    }
    return {
        log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        },
        apiClient: {
            uploadRunLog: vi.fn(),
            sendFlowResponse: vi.fn(),
            ...apiOverrides,
        },
        sandboxManager: {
            acquire: vi.fn().mockReturnValue(mockSandbox),
            release: vi.fn(),
            invalidate: vi.fn(),
        },
        engineToken: 'test-token',
        internalApiUrl: 'http://localhost:3000',
        publicApiUrl: 'http://localhost:4200',
        mockSandbox,
    } as any
}

describe('executeFlowJob', () => {
    beforeEach(() => {
        mockGetVersion.mockResolvedValue(makeFlowVersion())
    })

    describe('payload pass-through (no worker-side fetch)', () => {
        it('forwards the JobPayload ref unchanged to the engine for BEGIN', async () => {
            const ctx = makeMockContext()
            const data = makeResumeJobData({
                executionType: ExecutionType.BEGIN,
                payload: { type: 'ref', fileId: 'huge-file-1' },
            })

            await executeFlowJob.execute(ctx, data)

            const operation = ctx.mockSandbox.execute.mock.calls[0][1]
            expect(operation.executionType).toBe(ExecutionType.BEGIN)
            expect(operation.triggerPayload).toEqual({ type: 'ref', fileId: 'huge-file-1' })
            expect(operation.executionState).toBeUndefined()
        })

        it('forwards the JobPayload ref unchanged to the engine for RESUME and never reads logsFileId', async () => {
            const ctx = makeMockContext()
            const data = makeResumeJobData({
                payload: { type: 'ref', fileId: 'resume-payload-1' },
                logsFileId: 'logs-file-1',
            })

            await executeFlowJob.execute(ctx, data)

            const operation = ctx.mockSandbox.execute.mock.calls[0][1]
            expect(operation.executionType).toBe(ExecutionType.RESUME)
            expect(operation.resumePayload).toEqual({ type: 'ref', fileId: 'resume-payload-1' })
            expect(operation.logsFileId).toBe('logs-file-1')
            expect(operation.executionState).toBeUndefined()
        })
    })

    describe('RESUME validation', () => {
        it('still throws when logsFileId is missing for RESUME', async () => {
            const ctx = makeMockContext()
            const data = makeResumeJobData({ logsFileId: undefined as unknown as string })

            try {
                await executeFlowJob.execute(ctx, data)
                expect.fail('should have thrown')
            }
            catch (e) {
                expect(e).toBeInstanceOf(QadamFlowError)
                expect((e as QadamFlowError).error.code).toBe(ErrorCode.RESUME_LOGS_FILE_MISSING)
            }

            expect(ctx.apiClient.uploadRunLog).toHaveBeenCalledWith(
                expect.objectContaining({ status: FlowRunStatus.INTERNAL_ERROR }),
            )
        })

        it('omits logsFileId when reporting the missing RESUME logs file', async () => {
            const ctx = makeMockContext()
            const data = makeResumeJobData({ logsFileId: undefined as unknown as string })

            await expect(executeFlowJob.execute(ctx, data)).rejects.toBeInstanceOf(QadamFlowError)

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.INTERNAL_ERROR)
            expect(reported.logsFileId).toBeUndefined()
        })
    })

    describe('missing piece handling', () => {
        it('marks run as FAILED and skips sandbox when flow version is not found', async () => {
            mockGetVersion.mockResolvedValue(null)

            const ctx = makeMockContext()
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN })

            const result = await executeFlowJob.execute(ctx, data)

            expect(result.kind).toBe(JobResultKind.FIRE_AND_FORGET)

            expect(ctx.apiClient.uploadRunLog).toHaveBeenCalledWith(
                expect.objectContaining({ status: FlowRunStatus.FAILED }),
            )

            expect(ctx.sandboxManager.acquire).not.toHaveBeenCalled()
        })

        it('omits logsFileId when the flow version is not found, the engine never ran', async () => {
            mockGetVersion.mockResolvedValue(null)

            const ctx = makeMockContext()
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, logsFileId: 'logs-file-1' })

            await executeFlowJob.execute(ctx, data)

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.FAILED)
            expect(reported.logsFileId).toBeUndefined()
        })

        it('omits logsFileId when piece provisioning fails, the engine never ran', async () => {
            mockProvisionFlowPieces.mockResolvedValueOnce({ provisioned: false, unavailableQadam: '@aiqadam/qadam-tables@0.3.1' })

            const ctx = makeMockContext()
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, logsFileId: 'logs-file-1' })

            await executeFlowJob.execute(ctx, data)

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.FAILED)
            expect(reported.logsFileId).toBeUndefined()
            expect(ctx.sandboxManager.acquire).not.toHaveBeenCalled()
        })

        it('keeps logsFileId when piece provisioning throws, preserving the internalError detail', async () => {
            mockProvisionFlowPieces.mockRejectedValueOnce(new Error('registry unreachable'))

            const ctx = makeMockContext()
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, logsFileId: 'logs-file-1' })

            await expect(executeFlowJob.execute(ctx, data)).rejects.toThrow('registry unreachable')

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.INTERNAL_ERROR)
            expect(reported.logsFileId).toBe('logs-file-1')
            expect(reported.internalError).toBeDefined()
        })

        it('keeps logsFileId on sandbox timeout, the engine may have uploaded snapshots', async () => {
            const ctx = makeMockContext()
            ctx.mockSandbox.execute.mockRejectedValueOnce(new QadamFlowError({
                code: ErrorCode.SANDBOX_EXECUTION_TIMEOUT,
                params: { standardOutput: '', standardError: '' },
            }, 'timed out'))
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, logsFileId: 'logs-file-1' })

            await executeFlowJob.execute(ctx, data)

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.TIMEOUT)
            expect(reported.logsFileId).toBe('logs-file-1')
        })

        it('keeps logsFileId when the engine reports an internal error', async () => {
            const ctx = makeMockContext()
            ctx.mockSandbox.execute.mockResolvedValueOnce({ status: EngineResponseStatus.INTERNAL_ERROR, error: 'boom' })
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, logsFileId: 'logs-file-1' })

            await executeFlowJob.execute(ctx, data)

            const reported = ctx.apiClient.uploadRunLog.mock.calls[0][0]
            expect(reported.status).toBe(FlowRunStatus.INTERNAL_ERROR)
            expect(reported.logsFileId).toBe('logs-file-1')
        })
    })

    describe('sync caller response on failure', () => {
        it('answers the waiting sync caller with an explicit 500 instead of leaving it to time out', async () => {
            mockGetVersion.mockResolvedValue(null)
            const ctx = makeMockContext()
            const data = makeResumeJobData({ workerHandlerId: 'handler-1', httpRequestId: 'req-1' })

            await executeFlowJob.execute(ctx, data)

            expect(ctx.apiClient.sendFlowResponse).toHaveBeenCalledWith({
                workerHandlerId: 'handler-1',
                httpRequestId: 'req-1',
                runResponse: {
                    status: 500,
                    body: {
                        message: 'The flow run did not complete successfully.',
                        runId: 'run-1',
                        status: FlowRunStatus.FAILED,
                    },
                    headers: {},
                },
            })
        })

        it('reports the terminal status that actually occurred', async () => {
            const ctx = makeMockContext()
            ctx.mockSandbox.execute.mockRejectedValueOnce(new QadamFlowError({
                code: ErrorCode.SANDBOX_EXECUTION_TIMEOUT,
                params: { standardOutput: '', standardError: '' },
            }, 'timed out'))
            const data = makeResumeJobData({ executionType: ExecutionType.BEGIN, workerHandlerId: 'handler-1', httpRequestId: 'req-1' })

            await executeFlowJob.execute(ctx, data)

            const sent = ctx.apiClient.sendFlowResponse.mock.calls[0][0]
            expect(sent.runResponse.body.status).toBe(FlowRunStatus.TIMEOUT)
        })

        it('stays silent when no sync caller is waiting', async () => {
            mockGetVersion.mockResolvedValue(null)
            const ctx = makeMockContext()

            await executeFlowJob.execute(ctx, makeResumeJobData())

            expect(ctx.apiClient.sendFlowResponse).not.toHaveBeenCalled()
        })

        it('stays silent on a run that did not fail', async () => {
            const ctx = makeMockContext()
            const data = makeResumeJobData({ workerHandlerId: 'handler-1', httpRequestId: 'req-1' })

            await executeFlowJob.execute(ctx, data)

            expect(ctx.apiClient.sendFlowResponse).not.toHaveBeenCalled()
        })

        it('never lets a failed response publish cost the run its status upload', async () => {
            mockGetVersion.mockResolvedValue(null)
            const ctx = makeMockContext({ sendFlowResponse: vi.fn().mockRejectedValue(new Error('pubsub down')) })
            const data = makeResumeJobData({ workerHandlerId: 'handler-1', httpRequestId: 'req-1' })

            await executeFlowJob.execute(ctx, data)

            expect(ctx.apiClient.uploadRunLog).toHaveBeenCalledWith(
                expect.objectContaining({ status: FlowRunStatus.FAILED }),
            )
        })
    })
})
