import { ErrorCode, FlowRetryStrategy, FlowRunStatus, FlowTriggerType, QadamFlowError, RunEnvironment, StepOutputStatus } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    mockRepoUpdate,
    mockGetOneOrThrow,
    mockGetLatestLockedVersionOrThrow,
    mockGetPlatformId,
    mockOnRetry,
    mockFileGetDataOrUndefined,
    mockJobQueueAdd,
    mockOffloadPayload,
    mockMaybeOffloadPayload,
    runRowHolder,
} = vi.hoisted(() => ({
    mockRepoUpdate: vi.fn(),
    mockGetOneOrThrow: vi.fn(),
    mockGetLatestLockedVersionOrThrow: vi.fn(),
    mockGetPlatformId: vi.fn(),
    mockOnRetry: vi.fn(),
    mockFileGetDataOrUndefined: vi.fn(),
    mockJobQueueAdd: vi.fn(),
    mockOffloadPayload: vi.fn(),
    mockMaybeOffloadPayload: vi.fn(),
    // `retry()` reads the old run through the real `flowRunRepo()` query-builder chain
    // (`queryBuilderForFlowRun(...).where(...).getOne()`), used both by `getOnePopulatedOrThrow`
    // (initial read) and by `findFlowRunOrThrow` (post-update re-read). One fake builder that
    // always resolves the current row covers both call sites; it is mutated per-test through this
    // holder object rather than reassigned, since `vi.mock` factories only see the hoisted bindings.
    runRowHolder: { current: null as Record<string, unknown> | null },
}))

function queryBuilder() {
    const builder = {
        leftJoinAndSelect: () => builder,
        addSelect: () => builder,
        where: () => builder,
        andWhere: () => builder,
        getOne: () => Promise.resolve(runRowHolder.current),
    }
    return builder
}

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        createQueryBuilder: () => queryBuilder(),
        update: mockRepoUpdate,
    }),
}))

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedStore: { get: vi.fn(), put: vi.fn() },
    // Pulled in transitively (encryption.ts reads this at module scope) even though `retry()`
    // never exercises it on the code paths under test here.
    redisConnections: { getRedisType: vi.fn(() => 'SINGLE'), create: vi.fn(), useExisting: vi.fn() },
}))

vi.mock('../../../../../src/app/file/file.service', () => ({
    fileService: vi.fn(() => ({
        getDataOrUndefined: mockFileGetDataOrUndefined,
    })),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionService: vi.fn(() => ({
        getOneOrThrow: mockGetOneOrThrow,
        getLatestLockedVersionOrThrow: mockGetLatestLockedVersionOrThrow,
    })),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: mockGetPlatformId,
    })),
}))

vi.mock('../../../../../src/app/flows/flow-run/flow-run-side-effects', () => ({
    flowRunSideEffects: vi.fn(() => ({
        onRetry: mockOnRetry,
        onStart: vi.fn(),
        onResume: vi.fn(),
        onFinish: vi.fn(),
    })),
}))

vi.mock('../../../../../src/app/workers/job-queue/job-queue', () => ({
    jobQueue: vi.fn(() => ({
        add: mockJobQueueAdd,
        removeOneTimeJob: vi.fn(),
    })),
    JobType: { ONE_TIME: 'ONE_TIME' },
}))

vi.mock('../../../../../src/app/workers/payload-offloader', () => ({
    payloadOffloader: {
        offloadPayload: mockOffloadPayload,
        maybeOffloadPayload: mockMaybeOffloadPayload,
    },
}))

import { flowRunService } from '../../../../../src/app/flows/flow-run/flow-run-service'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

const REDACTED = '**REDACTED**'

function trigger({ name = 'trigger', logOutput }: { name?: string, logOutput?: boolean } = {}) {
    return {
        name,
        type: FlowTriggerType.PIECE,
        valid: true,
        displayName: 'Trigger',
        logOutput,
        settings: {
            qadamName: 'schedule',
            qadamVersion: '0.0.2',
            triggerName: 'cron_expression',
            propertySettings: {},
            input: {},
        },
    }
}

function flowVersion({ id = 'fv-1', logOutput }: { id?: string, logOutput?: boolean } = {}) {
    return { id, trigger: trigger({ logOutput }) }
}

function flowRun({ status, triggerOutput, inheritedRunLocale }: { status: FlowRunStatus, triggerOutput: unknown, inheritedRunLocale?: string }) {
    return {
        id: 'run-1',
        projectId: 'project-1',
        flowId: 'flow-1',
        flowVersionId: 'fv-1',
        environment: RunEnvironment.PRODUCTION,
        status,
        created: new Date().toISOString(),
        logsFileId: 'file-1',
        failParentOnFailure: true,
        steps: { trigger: { status: StepOutputStatus.SUCCEEDED, output: triggerOutput } },
        inheritedRunLocale,
    }
}

describe('flowRunService().retry — refuses to replay a redacted trigger payload (#505 review fix)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockOnRetry.mockResolvedValue(undefined)
        mockOffloadPayload.mockResolvedValue({ type: 'inline', value: null })
        mockMaybeOffloadPayload.mockResolvedValue({ type: 'inline', value: null })
        mockJobQueueAdd.mockResolvedValue(undefined)
        mockRepoUpdate.mockResolvedValue(undefined)
    })

    describe('FROM_FAILED_STEP', () => {
        it('refuses when the persisted trigger output is the redaction placeholder', async () => {
            const run = flowRun({ status: FlowRunStatus.FAILED, triggerOutput: REDACTED })
            runRowHolder.current = run
            mockFileGetDataOrUndefined.mockResolvedValue({
                data: Buffer.from(JSON.stringify({ executionState: { steps: run.steps } })),
            })
            mockGetOneOrThrow.mockResolvedValue(flowVersion({ logOutput: false }))

            await expect(flowRunService(log).retry({
                flowRunId: 'run-1',
                projectId: 'project-1',
                strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            })).rejects.toSatisfy((err: unknown) =>
                err instanceof QadamFlowError && err.error.code === ErrorCode.VALIDATION,
            )

            expect(mockRepoUpdate).not.toHaveBeenCalled()
        })

        it('refuses when the version the run ran on has trigger logOutput off, even if the output looks present', async () => {
            const run = flowRun({ status: FlowRunStatus.SUCCEEDED, triggerOutput: { real: 'payload' } })
            runRowHolder.current = run
            mockFileGetDataOrUndefined.mockResolvedValue({
                data: Buffer.from(JSON.stringify({ executionState: { steps: run.steps } })),
            })
            mockGetOneOrThrow.mockResolvedValue(flowVersion({ logOutput: false }))

            await expect(flowRunService(log).retry({
                flowRunId: 'run-1',
                projectId: 'project-1',
                strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            })).rejects.toSatisfy((err: unknown) =>
                err instanceof QadamFlowError && err.error.code === ErrorCode.VALIDATION,
            )

            expect(mockRepoUpdate).not.toHaveBeenCalled()
        })

        it('still retries a normal run whose trigger output was logged', async () => {
            runRowHolder.current = flowRun({ status: FlowRunStatus.FAILED, triggerOutput: { real: 'payload' } })
            mockFileGetDataOrUndefined.mockResolvedValue({
                data: Buffer.from(JSON.stringify({ executionState: { steps: {} } })),
            })
            mockGetOneOrThrow.mockResolvedValue(flowVersion({ logOutput: true }))

            const result = await flowRunService(log).retry({
                flowRunId: 'run-1',
                projectId: 'project-1',
                strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            })

            expect(result.id).toBe('run-1')
            expect(mockRepoUpdate).toHaveBeenCalled()
            expect(mockJobQueueAdd).toHaveBeenCalled()
        })
    })

    describe('ON_LATEST_VERSION', () => {
        it('refuses using the version the run ran on, not the latest version being retried to', async () => {
            const run = flowRun({ status: FlowRunStatus.SUCCEEDED, triggerOutput: REDACTED })
            runRowHolder.current = run
            mockFileGetDataOrUndefined.mockResolvedValue({
                data: Buffer.from(JSON.stringify({ executionState: { steps: run.steps } })),
            })
            mockGetLatestLockedVersionOrThrow.mockResolvedValue(flowVersion({ id: 'fv-latest', logOutput: true }))
            mockGetOneOrThrow.mockResolvedValue(flowVersion({ id: 'fv-1', logOutput: false }))

            await expect(flowRunService(log).retry({
                flowRunId: 'run-1',
                projectId: 'project-1',
                strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            })).rejects.toSatisfy((err: unknown) =>
                err instanceof QadamFlowError && err.error.code === ErrorCode.VALIDATION,
            )

            expect(mockRepoUpdate).not.toHaveBeenCalled()
            expect(mockJobQueueAdd).not.toHaveBeenCalled()
        })
    })
})

// #420 review M2: neither branch of FROM_FAILED_STEP used to forward the run's own persisted
// `inheritedRunLocale` into the re-dispatched job at all — a queued subflow child that later
// failed and was retried silently lost its parent's inherited locale, even though the value was
// sitting right there on the row `retry()` already re-reads.
describe('flowRunService().retry — forwards inheritedRunLocale into the re-dispatched job', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockOnRetry.mockResolvedValue(undefined)
        mockOffloadPayload.mockResolvedValue({ type: 'inline', value: null })
        mockMaybeOffloadPayload.mockResolvedValue({ type: 'inline', value: null })
        mockJobQueueAdd.mockResolvedValue(undefined)
        mockRepoUpdate.mockResolvedValue(undefined)
    })

    it('FROM_FAILED_STEP, trigger failed: re-sends the run\'s own inheritedRunLocale', async () => {
        runRowHolder.current = flowRun({ status: FlowRunStatus.FAILED, triggerOutput: undefined, inheritedRunLocale: 'ru' })
        mockFileGetDataOrUndefined.mockResolvedValue({
            data: Buffer.from(JSON.stringify({ executionState: { steps: { trigger: { status: StepOutputStatus.FAILED, output: { real: 'payload' } } } } })),
        })
        mockGetOneOrThrow.mockResolvedValue(flowVersion({ logOutput: true }))

        await flowRunService(log).retry({
            flowRunId: 'run-1',
            projectId: 'project-1',
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
        })

        expect(mockJobQueueAdd).toHaveBeenCalledTimes(1)
        const jobData = mockJobQueueAdd.mock.calls[0][0].data
        expect(jobData.executeTrigger).toBe(true)
        expect(jobData.inheritedRunLocale).toBe('ru')
    })

    it('FROM_FAILED_STEP, resuming a non-trigger step: re-sends the run\'s own inheritedRunLocale', async () => {
        runRowHolder.current = flowRun({ status: FlowRunStatus.FAILED, triggerOutput: { real: 'payload' }, inheritedRunLocale: 'ru' })
        mockFileGetDataOrUndefined.mockResolvedValue({
            data: Buffer.from(JSON.stringify({ executionState: { steps: runRowHolder.current.steps } })),
        })
        mockGetOneOrThrow.mockResolvedValue(flowVersion({ logOutput: true }))

        await flowRunService(log).retry({
            flowRunId: 'run-1',
            projectId: 'project-1',
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
        })

        expect(mockJobQueueAdd).toHaveBeenCalledTimes(1)
        const jobData = mockJobQueueAdd.mock.calls[0][0].data
        expect(jobData.inheritedRunLocale).toBe('ru')
    })
})
