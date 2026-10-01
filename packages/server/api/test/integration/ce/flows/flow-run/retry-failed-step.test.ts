/**
 * A retry reuses the failed run's row. The runs-metadata update only ever sets `failedStep` (an
 * absent one means "leave it"), so the retry itself has to clear the previous attempt's failure (#599).
 */
import { FlowRetryStrategy, FlowRunStatus, FlowVersionState, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { distributedStore } from '../../../../../src/app/database/redis-connections'
import { redisMetadataKey, RunsMetadataUpsertData } from '../../../../../src/app/workers/job'
import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

let app: FastifyInstance
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app)
})

describe('Retry clears the previous attempt\'s failedStep (#599)', () => {
    it('leaves failedStep null when the retried attempt succeeds', async () => {
        const { runId } = await createRunFailedAt({ stepName: 'step_2' })

        await retryFromFailedStep({ runId })
        expect((await readRun({ runId })).failedStep).toBeNull()

        await reportAttempt({ runId, status: FlowRunStatus.RUNNING })
        await reportAttempt({ runId, status: FlowRunStatus.SUCCEEDED, finishTime: new Date().toISOString() })
        await waitForStatus({ runId, status: FlowRunStatus.SUCCEEDED })

        const run = await readRun({ runId })
        expect(run.status).toBe(FlowRunStatus.SUCCEEDED)
        expect(run.failedStep).toBeNull()
    })

    it('records the step the retried attempt failed at, not the previous one', async () => {
        const { runId } = await createRunFailedAt({ stepName: 'step_A' })

        await retryFromFailedStep({ runId })
        await reportAttempt({
            runId,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
            failedStep: { name: 'step_B', displayName: 'Step B', message: 'second failure' },
        })
        await waitForStatus({ runId, status: FlowRunStatus.FAILED })

        const run = await readRun({ runId })
        expect(run.failedStep?.name).toBe('step_B')
        expect(run.failedStep?.message).toBe('second failure')
    })

    it('clears failedStep on every run a bulk retry re-queues', async () => {
        const first = await createRunFailedAt({ stepName: 'step_1' })
        const second = await createRunFailedAt({ stepName: 'step_2' })

        const response = await ctx.post('/v1/flow-runs/retry', {
            projectId: ctx.project.id,
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            flowRunIds: [first.runId, second.runId],
        })
        expect(response.statusCode).toBe(200)

        expect((await readRun({ runId: first.runId })).failedStep).toBeNull()
        expect((await readRun({ runId: second.runId })).failedStep).toBeNull()
    })

    it('does not touch the original run when retrying on the latest version', async () => {
        const { runId } = await createRunFailedAt({ stepName: 'step_2' })

        const response = await ctx.post(`/v1/flow-runs/${runId}/retry`, {
            strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            projectId: ctx.project.id,
        })
        expect(response.statusCode).toBe(200)
        expect(response.json().id).not.toBe(runId)

        expect((await readRun({ runId })).failedStep?.name).toBe('step_2')
    })
})

async function createRunFailedAt({ stepName }: { stepName: string }): Promise<{ runId: string }> {
    const flow = createMockFlow({ projectId: ctx.project.id })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    const flowRun = createMockFlowRun({
        projectId: ctx.project.id,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: FlowRunStatus.FAILED,
        environment: RunEnvironment.PRODUCTION,
        logsFileId: null,
    })
    await db.save('flow_run', { ...flowRun, failedStep: { name: stepName, displayName: stepName, message: 'first failure' } })
    return { runId: flowRun.id }
}

async function retryFromFailedStep({ runId }: { runId: string }): Promise<void> {
    const response = await ctx.post(`/v1/flow-runs/${runId}/retry`, {
        strategy: FlowRetryStrategy.FROM_FAILED_STEP,
        projectId: ctx.project.id,
    })
    expect(response.statusCode).toBe(200)
}

// The same entry the engine's progress reports take; the row is written by the metadata drain.
async function reportAttempt({ runId, status, finishTime, failedStep }: ReportAttemptParams): Promise<void> {
    await createHandlers({ log: app.log, disconnected: new AbortController().signal }).uploadRunLog({
        runId,
        projectId: ctx.project.id,
        status,
        finishTime,
        failedStep,
    })
    await waitForMetadataConsumed({ runId })
}

async function readRun({ runId }: { runId: string }): Promise<StoredRun> {
    return db.findOneByOrFail<StoredRun>('flow_run', { id: runId })
}

async function waitForStatus({ runId, status }: { runId: string, status: FlowRunStatus }): Promise<void> {
    await waitForCondition({ fn: async () => (await readRun({ runId })).status === status })
}

async function waitForMetadataConsumed({ runId }: { runId: string }): Promise<void> {
    await waitForCondition({
        fn: async () => {
            const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(runId))
            return pending === null || Object.keys(pending).length === 0
        },
    })
}

async function waitForCondition({ fn, timeoutMs = 10000 }: { fn: () => Promise<boolean>, timeoutMs?: number }): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('waitForCondition timed out')
}

type StoredRun = {
    status: string
    failedStep: { name: string, displayName: string, message?: string } | null
}

type ReportAttemptParams = {
    runId: string
    status: FlowRunStatus
    finishTime?: string
    failedStep?: { name: string, displayName: string, message?: string }
}
