import { apId, FlowRunStatus, FlowVersionState, isNil, ResumeExecuteFlowJobData, RunEnvironment } from '@aiqadam/shared'
import { Queue } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { distributedStore, redisConnections } from '../../../../../src/app/database/redis-connections'
import { batchDeleteByFlowId } from '../../../../../src/app/flows/flow/flow.jobs'
import * as flowRunServiceModule from '../../../../../src/app/flows/flow-run/flow-run-service'
import { flowRunSideEffects } from '../../../../../src/app/flows/flow-run/flow-run-side-effects'
import { waitpointService } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-service'
import { pubsub } from '../../../../../src/app/helper/pubsub'
import * as engineResponseWatcherModule from '../../../../../src/app/workers/engine-response-watcher'
import { QueueName, redisMetadataKey, RunsMetadataUpsertData } from '../../../../../src/app/workers/job'
import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

const { engineResponseWatcher } = engineResponseWatcherModule

async function waitForCondition({ fn, timeoutMs = 5000 }: WaitForConditionParams): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('waitForCondition timed out')
}

// The httpRequestId the server actually keys its sync listener by is minted internally
// (a fresh apId(), or the caller-opaque waitpointId) and never returned to the test directly.
// The resume job's own queue entry — id'd by flowRunId, per addToQueue — is the one place it's
// externally observable, so tests read it from there instead of guessing/hardcoding a key.
async function waitForResumeJobHttpRequestId({ flowRunId, timeoutMs = 5000 }: { flowRunId: string, timeoutMs?: number }): Promise<string> {
    const queue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
    try {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const job = await queue.getJob(flowRunId)
            if (job) {
                const jobData = ResumeExecuteFlowJobData.parse(job.data)
                if (jobData.httpRequestId) {
                    return jobData.httpRequestId
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Timed out waiting for a queued resume job for run ${flowRunId}`)
    }
    finally {
        await queue.close()
    }
}

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

async function createPausedFlowRunWithWaitpoint(params: {
    projectId: string
}) {
    const flow = createMockFlow({ projectId: params.projectId })
    await db.save('flow', flow)

    const flowVersion = createMockFlowVersion({
        flowId: flow.id,
        state: FlowVersionState.LOCKED,
    })
    await db.save('flow_version', flowVersion)

    const flowRun = createMockFlowRun({
        projectId: params.projectId,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: FlowRunStatus.PAUSED,
        environment: RunEnvironment.PRODUCTION,
    })
    await db.save('flow_run', flowRun)

    const waitpointId = apId()
    await db.save('waitpoint', {
        id: waitpointId,
        flowRunId: flowRun.id,
        projectId: params.projectId,
        stepName: 'approval',
        type: 'WEBHOOK',
        status: 'PENDING',
        httpRequestId: null,
        workerHandlerId: null,
    })

    return { flow, flowVersion, flowRun, waitpointId }
}

// A pre-shim (before the 2026-04-13 piece-API pause shim) V0 WEBHOOK pause: the shape
// resumeService#isEligibleForLegacyNoWaitpointResume requires on flow_run.pauseMetadata for the
// no-waitpoint legacy branch to accept a resume at all. Every legacy-pause fixture below that
// expects to actually resume through that branch needs this — a run with no pauseMetadata (NULL,
// the shim-era/current shape) or a DELAY pauseMetadata must NOT be accepted, see the dedicated
// tests for those below.
function legacyWebhookPauseMetadata(): Record<string, unknown> {
    return { type: 'WEBHOOK', requestId: apId(), response: {} }
}

describe('Resume flow run', () => {
    it('should resume legacy PAUSED flow with no waitpoint via async endpoint', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'Your response has been recorded. You can close this page now.',
        })
    })

    it('should treat legacy PAUSED flow with no waitpoint and no pauseMetadata as stale', async () => {
        // Every V0 pause since the piece-API pause shim (2026-04-13) creates a real waitpoint row
        // itself, so a PAUSED run with NEITHER a waitpoint row NOR pre-shim pauseMetadata cannot
        // be a legitimate pending approval — it must not be resumable via the run id alone.
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: null })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })

        const jobsQueue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
        try {
            const job = await jobsQueue.getJob(flowRun.id)
            expect(job).toBeFalsy()
        }
        finally {
            await jobsQueue.close()
        }
    })

    it('should treat legacy PAUSED flow with no waitpoint and a DELAY pauseMetadata as stale', async () => {
        // A DELAY pause is never resumed by this HTTP route at all: refill-paused-jobs.ts only
        // reschedules RESUME_DELAY_WAITPOINT for a run that already has a DELAY waitpoint row (it
        // skips a paused run whose waitpoint is nil or not DELAY; it never creates one). A pre-shim
        // DELAY run with no waitpoint row is resumed by its original delayed job, or not at all —
        // this route was never in that path. A DELAY pauseMetadata reaching here is not this
        // route's case.
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', {
            ...flowRun,
            pauseMetadata: { type: 'DELAY', resumeDateTime: new Date(Date.now() + 60000).toISOString() },
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('should treat a non-PAUSED flow run with a valid legacy WEBHOOK pauseMetadata and no waitpoint as stale', async () => {
        // Isolates the status===PAUSED guard on its own: pauseMetadata and the no-waitpoint
        // condition are both otherwise satisfied here, so only the status check can be the reason
        // this is refused.
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('should trigger resume when uploadRunLog finds a pre-completed waitpoint', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)

        const runId = flowRun.id

        await distributedStore.merge(redisMetadataKey(runId), {
            id: runId,
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.RUNNING,
        })

        await db.save('waitpoint', {
            id: apId(),
            flowRunId: runId,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'COMPLETED',
            resumePayload: {
                payload: { body: { status: 'success' } },
                progressUpdateType: 'TEST_FLOW',
                executionType: 'RESUME',
            },
        })

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({
            runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.PAUSED,
        })

        await waitForCondition({
            fn: async () => {
                const wp = await db.findOneBy('waitpoint', { flowRunId: runId })
                return wp === null
            },
        })

        const dbRun = await db.findOneBy<{ id: string, status: string }>('flow_run', { id: runId })
        expect(dbRun).not.toBeNull()

        const waitpoint = await db.findOneBy('waitpoint', { flowRunId: runId })
        expect(waitpoint).toBeNull()
    })

    it('should not resume when flow is in terminal state', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.SUCCEEDED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
    })

    it('sync: should resume legacy PAUSED flow with no waitpoint', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const responsePromise = app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}/sync`,
            body: { data: 'test' },
        })

        // #518: the legacy branch mints its own key rather than trusting the caller-chosen,
        // unvalidated :requestId param — read the actual key off the queued resume job.
        const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: flowRun.id })
        await pubsub.publish(`engine-run:sync:${engineResponseWatcher(app.log).getServerId()}`, JSON.stringify({
            requestId: httpRequestId,
            response: { status: 200, body: { ok: true }, headers: {} },
        }))

        const response = await responsePromise
        expect(response.statusCode).toBe(200)
    })

    it('should persist PAUSED status for a Redis-only run', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const runId = apId()
        const requestId = apId()

        const runMetadata: RunsMetadataUpsertData = {
            id: runId,
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.RUNNING,
        }
        await distributedStore.merge(redisMetadataKey(runId), runMetadata)

        await db.save('waitpoint', {
            id: apId(),
            flowRunId: runId,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({
            runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.PAUSED,
        })

        await waitForCondition({
            fn: async () => {
                const dbRun = await db.findOneBy<{ status: string }>('flow_run', { id: runId })
                return dbRun?.status === FlowRunStatus.PAUSED
            },
        })

        const waitpoint = await db.findOneBy<{ status: string, type: string }>('waitpoint', { flowRunId: runId })
        expect(waitpoint).not.toBeNull()
        expect(waitpoint!.status).toBe('PENDING')
        expect(waitpoint!.type).toBe('WEBHOOK')

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${runId}/requests/${requestId}`,
            body: { status: 'success', data: { greeting: 'Hello' } },
        })
        expect(response.statusCode).toBe(200)
    })

    it('should persist DELAY waitpoint with waitpointId via uploadRunLog', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const runId = apId()
        const resumeDateTime = new Date(Date.now() + 60000).toISOString()

        const runMetadata: RunsMetadataUpsertData = {
            id: runId,
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.RUNNING,
        }
        await distributedStore.merge(redisMetadataKey(runId), runMetadata)

        await db.save('waitpoint', {
            id: apId(),
            flowRunId: runId,
            projectId: ctx.project.id,
            stepName: 'delay_step',
            type: 'DELAY',
            status: 'PENDING',
            resumeDateTime,
            httpRequestId: null,
            workerHandlerId: null,
        })

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({
            runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.PAUSED,
        })

        await waitForCondition({
            fn: async () => {
                const dbRun = await db.findOneBy<{ status: string }>('flow_run', { id: runId })
                return dbRun?.status === FlowRunStatus.PAUSED
            },
        })

        const waitpoint = await db.findOneBy<{ status: string, type: string, resumeDateTime: string }>('waitpoint', { flowRunId: runId })
        expect(waitpoint).not.toBeNull()
        expect(waitpoint!.type).toBe('DELAY')
        expect(waitpoint!.status).toBe('PENDING')
        expect(new Date(waitpoint!.resumeDateTime).toISOString()).toBe(resumeDateTime)
    })

    it('should clean up waitpoint when flow run finishes (onFinish)', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const waitpointBefore = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointBefore).not.toBeNull()

        await db.update('flow_run', flowRun.id, { status: FlowRunStatus.SUCCEEDED })
        const updatedRun = await db.findOneByOrFail<{ id: string, status: string, projectId: string }>('flow_run', { id: flowRun.id })
        await flowRunSideEffects(app.log).onFinish(updatedRun as any)

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()
    })

    it('markParentRunAsFailed should complete waitpoint when parent is PAUSED', async () => {
        const { flowRun: parentRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: parentRun.flowId,
            flowVersionId: parentRun.flowVersionId,
            status: FlowRunStatus.FAILED,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
        })
        await db.save('flow_run', childRun)

        const existingWaitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: parentRun.id })
        await waitpointService(app.log).complete({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            waitpointId: existingWaitpoint!.id,
            resumePayload: { body: { status: 'error', data: { message: 'Subflow execution failed' } } },
        })

        const waitpoint = await db.findOneBy<{ status: string, resumePayload: unknown }>('waitpoint', { flowRunId: parentRun.id })
        expect(waitpoint).not.toBeNull()
        expect(waitpoint!.status).toBe('COMPLETED')
    })

    it('markParentRunAsFailed should drop the failure when parent has no PENDING waitpoint (regression: subflow retry must not hijack a future pause)', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const parentRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', parentRun)

        const result = await waitpointService(app.log).complete({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            waitpointId: apId(),
            resumePayload: { body: { status: 'error', data: { message: 'Subflow execution failed' } } },
        })

        expect(result.completedExisting).toBe(false)
        expect(result.waitpoint).toBeNull()

        const waitpoint = await db.findOneBy('waitpoint', { flowRunId: parentRun.id })
        expect(waitpoint).toBeNull()
    })

    it('markParentRunAsFailed should not touch a parent run in another project (#520)', async () => {
        const otherCtx = await createTestContext(app)
        const { flowRun: parentRun, waitpointId } = await createPausedFlowRunWithWaitpoint({
            projectId: otherCtx.project.id,
        })

        const childFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', childFlow)
        const childFlowVersion = createMockFlowVersion({
            flowId: childFlow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', childFlowVersion)
        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: childFlow.id,
            flowVersionId: childFlowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: waitpointId,
        })
        await db.save('flow_run', childRun)

        await createHandlers(app.log).uploadRunLog({
            runId: childRun.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        // The child's status flips to FAILED before markParentRunAsFailed runs (it reads off
        // the already-saved row), so waiting on that status alone races the very call this test
        // is meant to observe. consumeProcessedMetadata — which clears this Redis hash — runs
        // after markParentRunAsFailed in processRunsMetadataUpdate, so waiting for it to be gone
        // guarantees the drain, including markParentRunAsFailed, has already finished.
        await waitForCondition({
            fn: async () => {
                const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(childRun.id))
                return isNil(pending) || Object.keys(pending).length === 0
            },
        })

        const parentAfter = await db.findOneByOrFail<{ status: string }>('flow_run', { id: parentRun.id })
        expect(parentAfter.status).toBe(FlowRunStatus.PAUSED)

        const waitpointAfter = await db.findOneByOrFail<{ status: string }>('waitpoint', { flowRunId: parentRun.id })
        expect(waitpointAfter.status).toBe('PENDING')
    })

    it('markParentRunAsFailed should still fail/resume a same-project parent (#520)', async () => {
        const { flowRun: parentRun, waitpointId } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const childFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', childFlow)
        const childFlowVersion = createMockFlowVersion({
            flowId: childFlow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', childFlowVersion)
        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: childFlow.id,
            flowVersionId: childFlowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: waitpointId,
        })
        await db.save('flow_run', childRun)

        await createHandlers(app.log).uploadRunLog({
            runId: childRun.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        // A same-project resume runs the waitpoint through complete() (PENDING -> COMPLETED)
        // and then straight through resumeFromWaitpoint's PAUSED branch, which deletes the
        // waitpoint row once the resume is enqueued (see the "pre-completed waitpoint" test
        // above) — so "gone" is the observable signal that the parent was actually resumed,
        // not left untouched the way the cross-project parent above is.
        await waitForCondition({
            fn: async () => {
                const waitpoint = await db.findOneBy('waitpoint', { flowRunId: parentRun.id })
                return waitpoint === null
            },
        })

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: parentRun.id })
        expect(waitpointAfter).toBeNull()
    })

    it('markParentRunAsFailed should complete nothing when the child carries failParentOnFailure but no stored parentWaitpointId (legacy row, predates this column)', async () => {
        const { flowRun: parentRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const childFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', childFlow)
        const childFlowVersion = createMockFlowVersion({
            flowId: childFlow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', childFlowVersion)
        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: childFlow.id,
            flowVersionId: childFlowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            // No parentWaitpointId set — the shape of a run created before this column existed.
        })
        await db.save('flow_run', childRun)

        await createHandlers(app.log).uploadRunLog({
            runId: childRun.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        await waitForCondition({
            fn: async () => {
                const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(childRun.id))
                return isNil(pending) || Object.keys(pending).length === 0
            },
        })

        const parentAfter = await db.findOneByOrFail<{ status: string }>('flow_run', { id: parentRun.id })
        expect(parentAfter.status).toBe(FlowRunStatus.PAUSED)

        const waitpointAfter = await db.findOneByOrFail<{ status: string }>('waitpoint', { flowRunId: parentRun.id })
        expect(waitpointAfter.status).toBe('PENDING')
    })

    it('markParentRunAsFailed only ever completes the exact stored parentWaitpointId: a replayed/stale proof from an already-resumed waitpoint (W1) does not touch a later, different waitpoint (W2) on the same parent', async () => {
        const { flowRun: parentRun, waitpointId: w1 } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const childFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', childFlow)
        const childFlowVersion = createMockFlowVersion({
            flowId: childFlow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', childFlowVersion)

        const child1 = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: childFlow.id,
            flowVersionId: childFlowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: w1,
        })
        await db.save('flow_run', child1)

        await createHandlers(app.log).uploadRunLog({
            runId: child1.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        // W1 is resumed and its row deleted (same as the #520 same-project test above) before
        // the parent is given a second, unrelated waitpoint (W2) — standing in for the parent
        // having since paused again on a later step.
        await waitForCondition({
            fn: async () => {
                const waitpoint = await db.findOneBy('waitpoint', { flowRunId: parentRun.id })
                return waitpoint === null
            },
        })

        const w2 = apId()
        await db.save('waitpoint', {
            id: w2,
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            stepName: 'approval-2',
            type: 'WEBHOOK',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        // A second child, replaying (or still holding) W1's now-stale id as its stored proof —
        // e.g. a duplicate delivery of the same job data, or a retry that copied the old id
        // forward. `complete()` only ever matches an exact PENDING row by id, so this must not
        // touch W2, which is a different waitpoint entirely.
        const child2 = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: childFlow.id,
            flowVersionId: childFlowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: w1,
        })
        await db.save('flow_run', child2)

        await createHandlers(app.log).uploadRunLog({
            runId: child2.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        await waitForCondition({
            fn: async () => {
                const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(child2.id))
                return isNil(pending) || Object.keys(pending).length === 0
            },
        })

        const w2After = await db.findOneByOrFail<{ status: string }>('waitpoint', { id: w2 })
        expect(w2After.status).toBe('PENDING')
    })

    it('should drop stale resume signal when parent is already in terminal state and not produce a buffered waitpoint', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const parentRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.FAILED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', parentRun)

        const result = await waitpointService(app.log).complete({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            waitpointId: apId(),
            resumePayload: { body: { status: 'error', data: { message: 'Subflow execution failed' } } },
        })
        expect(result.completedExisting).toBe(false)
        expect(result.waitpoint).toBeNull()

        await waitpointService(app.log).handleResumeSignal({
            flowRunId: parentRun.id,
            waitpointId: apId(),
            flowRunStatus: FlowRunStatus.FAILED,
            projectId: ctx.project.id,
            resumePayload: { body: { status: 'error' } },
            onReady: async () => {
                throw new Error('onReady should not be called for terminal state')
            },
        })

        const orphanedWaitpoint = await db.findOneBy('waitpoint', { flowRunId: parentRun.id })
        expect(orphanedWaitpoint).toBeNull()
    })

    it('should resume via new /:id/waitpoints/:waitpointId route', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const waitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpoint).not.toBeNull()

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}`,
            body: { status: 'success', data: { greeting: 'Hello' } },
        })

        expect(response.statusCode).toBe(200)

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()
    })

    it('should return stale message on double resume via waitpoint route', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const waitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpoint).not.toBeNull()

        const firstResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}`,
            body: { status: 'success', data: { greeting: 'Hello' } },
        })
        expect(firstResponse.statusCode).toBe(200)
        expect(firstResponse.json()).toEqual({
            message: 'Your response has been recorded. You can close this page now.',
        })

        const secondResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}`,
            body: { status: 'success', data: { greeting: 'Hello again' } },
        })
        expect(secondResponse.statusCode).toBe(200)
        expect(secondResponse.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()
    })

    it('should clean up waitpoints when flow is deleted via batchDeleteByFlowId', async () => {
        const { flowRun, flow } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const waitpointBefore = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointBefore).not.toBeNull()

        await batchDeleteByFlowId(flow.id)

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()

        const runAfter = await db.findOneBy('flow_run', { id: flowRun.id })
        expect(runAfter).toBeNull()
    })

    it('V0 async: should resume via waitpoint path when V0 waitpoint exists', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })

        const waitpointBefore = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointBefore).not.toBeNull()

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { status: 'approved' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'Your response has been recorded. You can close this page now.',
        })

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()
    })

    // #527 app-sec finding: run ids appear in every resume URL, V0 or V1, sent to an external
    // approver — so anyone holding an EARLIER approval link for this run could otherwise reach
    // this run-id-only legacy route and resume the run's CURRENT, unrelated V1 pause with an
    // arbitrary payload, without ever learning the real waitpoint id, and without the real V1
    // waitpoint ever leaving PENDING. This run has a pre-shim WEBHOOK pauseMetadata (i.e. would
    // otherwise be a legitimate legacy-branch candidate on its own), but the presence of ANY
    // waitpoint row — regardless of version or status — must still refuse the no-waitpoint branch.
    it('V0 async: should treat run as stale when only a V1 waitpoint exists (no bypass via run id)', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const waitpointId = apId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V1',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { status: 'approved' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })

        const waitpointAfter = await db.findOneBy<{ id: string, version: string, status: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).not.toBeNull()
        expect(waitpointAfter!.id).toBe(waitpointId)
        expect(waitpointAfter!.version).toBe('V1')
        expect(waitpointAfter!.status).toBe('PENDING')

        const jobsQueue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
        try {
            const job = await jobsQueue.getJob(flowRun.id)
            expect(job).toBeFalsy()
        }
        finally {
            await jobsQueue.close()
        }
    })

    it('V0 sync: should treat run as stale when only a V1 waitpoint exists (no bypass via run id)', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const waitpointId = apId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V1',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}/sync`,
            body: { status: 'approved' },
        })

        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })

        const waitpointAfter = await db.findOneBy<{ id: string, version: string, status: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).not.toBeNull()
        expect(waitpointAfter!.id).toBe(waitpointId)
        expect(waitpointAfter!.version).toBe('V1')
        expect(waitpointAfter!.status).toBe('PENDING')

        const jobsQueue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
        try {
            const job = await jobsQueue.getJob(flowRun.id)
            expect(job).toBeFalsy()
        }
        finally {
            await jobsQueue.close()
        }
    })

    // Pins guard 3's "any status" wording: a COMPLETED waitpoint (not just a PENDING one) must
    // also refuse the no-waitpoint legacy branch. hasAnyWaitpoint counts any status/version.
    it('V0 async: should treat run as stale when only a COMPLETED waitpoint exists', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const waitpointId = apId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V0',
            status: 'COMPLETED',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}`,
            body: { status: 'approved' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })

        const jobsQueue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
        try {
            const job = await jobsQueue.getJob(flowRun.id)
            expect(job).toBeFalsy()
        }
        finally {
            await jobsQueue.close()
        }
    })

    it('V0 sync: should treat terminal-state flow run with no waitpoint as stale', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.SUCCEEDED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}/sync`,
            body: { data: 'test' },
        })

        // Behaviour change (#527): a non-PAUSED run with no waitpoint now fails the same combined
        // eligibility guard as every other ineligible case (see
        // isEligibleForLegacyNoWaitpointResume), and reports the generic "stale" response rather
        // than a status-specific 409. The V1/non-legacy waitpoint routes (handleSyncResumeFlow)
        // still answer a genuinely terminal run with 409 "Flow run is not paused" — that check is
        // unchanged; this route no longer runs it once a waitpoint doesn't exist to route through.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('V0 sync: should resume via waitpoint path when V0 waitpoint exists', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)

        const waitpointId = apId()
        const workerHandlerId = engineResponseWatcher(app.log).getServerId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'PENDING',
            workerHandlerId,
            httpRequestId: null,
        })

        const responsePromise = app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}/sync`,
            body: { data: 'test' },
        })

        // #518: the V0 sync route must key its listener by a fresh id it mints itself, never by
        // waitpoint.workerHandlerId (the SERVER_ID shared by every V0 waitpoint on this server).
        // The actual key isn't returned to the caller, so read it off the queued resume job.
        const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: flowRun.id })
        expect(httpRequestId).not.toBe(workerHandlerId)

        await pubsub.publish(`engine-run:sync:${workerHandlerId}`, JSON.stringify({
            requestId: httpRequestId,
            response: { status: 200, body: { ok: true }, headers: {} },
        }))

        const response = await responsePromise
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ ok: true })

        const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
        expect(waitpointAfter).toBeNull()
    })

    // #527: resume-controller resolves the run's own row exactly once (findFlowRunForLegacyResume,
    // via resolveV0FlowRun) before either branch — "has a PENDING V0 waitpoint" or the no-waitpoint
    // legacy fallback — is chosen. A flow run id that resolves to no row at all is not an error
    // here: this is the same "row not yet visible" tolerance the non-legacy waitpoint path already
    // applies (resumeFromWaitpoint's ENTITY_NOT_FOUND -> stale), and it now degrades to "stale"
    // directly in the controller rather than falling through to legacyResume/legacySyncResume at
    // all — a bogus/unknown flow run id gets "stale" here, not a 404.
    it('V0 async: should treat a nonexistent flow run as stale rather than erroring', async () => {
        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${apId()}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('V0 sync: should treat a nonexistent flow run as stale rather than erroring', async () => {
        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${apId()}/requests/${apId()}/sync`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    // #509 drain-lag case: a PENDING V0 waitpoint row can exist (waitpoint creation is a direct
    // synchronous write) for a flow run whose own row has not reached Postgres yet via the async
    // runsMetadataQueue drain. resolveV0FlowRun must still degrade to "stale" for this flow run id
    // — it must never reach findPendingByVersion (and so never read the orphaned waitpoint) before
    // the run's own row exists, and it must not throw.
    it('V0 async: should treat a PENDING V0 waitpoint with no flow_run row yet as stale', async () => {
        const orphanFlowRunId = apId()
        await db.save('waitpoint', {
            id: apId(),
            flowRunId: orphanFlowRunId,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V0',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${orphanFlowRunId}/requests/${apId()}`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('V0 sync: should treat a PENDING V0 waitpoint with no flow_run row yet as stale', async () => {
        const orphanFlowRunId = apId()
        await db.save('waitpoint', {
            id: apId(),
            flowRunId: orphanFlowRunId,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V0',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${orphanFlowRunId}/requests/${apId()}/sync`,
            body: { data: 'test' },
        })

        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual({
            message: 'This link has expired. The action may have already been processed.',
        })
    })

    it('V0 sync: two concurrent in-flight resumes on one server do not cross-talk', async () => {
        const workerHandlerId = engineResponseWatcher(app.log).getServerId()

        async function createV0PausedRunWithPendingWaitpoint(stepName: string): Promise<{ id: string }> {
            const flow = createMockFlow({ projectId: ctx.project.id })
            await db.save('flow', flow)
            const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
            await db.save('flow_version', flowVersion)
            const flowRun = createMockFlowRun({
                projectId: ctx.project.id,
                flowId: flow.id,
                flowVersionId: flowVersion.id,
                status: FlowRunStatus.PAUSED,
                environment: RunEnvironment.PRODUCTION,
            })
            await db.save('flow_run', flowRun)
            // Every V0 waitpoint created on this server shares this same workerHandlerId — that
            // is exactly the value the pre-#518 code mistakenly used as the sync listener key.
            await db.save('waitpoint', {
                id: apId(),
                flowRunId: flowRun.id,
                projectId: ctx.project.id,
                stepName,
                type: 'WEBHOOK',
                status: 'PENDING',
                workerHandlerId,
                httpRequestId: null,
            })
            return flowRun
        }

        const runA = await createV0PausedRunWithPendingWaitpoint('approval-a')
        const runB = await createV0PausedRunWithPendingWaitpoint('approval-b')

        const responseAPromise = app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${runA.id}/requests/${apId()}/sync`,
            body: { data: 'A' },
        })
        const responseBPromise = app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${runB.id}/requests/${apId()}/sync`,
            body: { data: 'B' },
        })

        const [httpRequestIdA, httpRequestIdB] = await Promise.all([
            waitForResumeJobHttpRequestId({ flowRunId: runA.id }),
            waitForResumeJobHttpRequestId({ flowRunId: runB.id }),
        ])

        // The bug in #518 was both ending up keyed by the shared per-process SERVER_ID.
        expect(httpRequestIdA).not.toBe(workerHandlerId)
        expect(httpRequestIdB).not.toBe(workerHandlerId)
        expect(httpRequestIdA).not.toBe(httpRequestIdB)

        // Deliver B's answer first, then A's — the order responses arrive in must not affect
        // which caller receives which body.
        await createHandlers(app.log).sendFlowResponse({
            workerHandlerId,
            httpRequestId: httpRequestIdB,
            runResponse: { status: 200, body: { owner: 'B' }, headers: {} },
        })
        await createHandlers(app.log).sendFlowResponse({
            workerHandlerId,
            httpRequestId: httpRequestIdA,
            runResponse: { status: 200, body: { owner: 'A' }, headers: {} },
        })

        const [responseA, responseB] = await Promise.all([responseAPromise, responseBPromise])
        expect(responseA.json()).toEqual({ owner: 'A' })
        expect(responseB.json()).toEqual({ owner: 'B' })
    })

    it('sync resume arriving while RUNNING still receives the run\'s answer after it pauses and is resumed', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)
        const runId = flowRun.id

        await distributedStore.merge(redisMetadataKey(runId), {
            id: runId,
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.RUNNING,
        })

        const waitpointId = apId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: runId,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const responsePromise = app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${runId}/waitpoints/${waitpointId}/sync`,
            body: { data: 'test' },
        })

        await waitForCondition({
            fn: async () => {
                const wp = await db.findOneBy<{ status: string }>('waitpoint', { flowRunId: runId })
                return wp?.status === 'COMPLETED'
            },
        })

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({ runId, projectId: ctx.project.id, status: FlowRunStatus.PAUSED })

        // #519: complete() must persist the caller's httpRequestId next to workerHandlerId so the
        // drain's pre-completed-waitpoint branch resumes with it, instead of falling back to a
        // fresh id nobody is listening on. #518: that httpRequestId must be a fresh id minted for
        // this request, never the waitpointId itself (unique per waitpoint, not per request) or
        // the shared per-process SERVER_ID — either one used as the key would let a second,
        // duplicate request to the same waitpoint collide with this one.
        const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: runId })
        expect(httpRequestId).not.toBe(waitpointId)

        const workerHandlerId = engineResponseWatcher(app.log).getServerId()
        expect(httpRequestId).not.toBe(workerHandlerId)
        await handlers.sendFlowResponse({
            workerHandlerId,
            httpRequestId,
            runResponse: { status: 200, body: { ok: true }, headers: {} },
        })

        const response = await responsePromise
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ ok: true })
    })

    it('registers the sync listener before enqueueing the resume, so an immediate engine response is not dropped', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)

        const waitpointId = apId()
        await db.save('waitpoint', {
            id: waitpointId,
            flowRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })

        const listenOrder = vi.fn()
        const enqueueOrder = vi.fn()

        const originalAddToQueue = flowRunServiceModule.addToQueue
        const addToQueueSpy = vi.spyOn(flowRunServiceModule, 'addToQueue').mockImplementation(async (params, log) => {
            enqueueOrder()
            return originalAddToQueue(params, log)
        })

        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        listenOrder()
                        return real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                    },
                }
            })

        try {
            const responsePromise = app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpointId}/sync`,
                body: { data: 'test' },
            })

            const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: flowRun.id })
            const workerHandlerId = engineResponseWatcher(app.log).getServerId()
            await createHandlers(app.log).sendFlowResponse({
                workerHandlerId,
                httpRequestId,
                runResponse: { status: 200, body: { ok: true }, headers: {} },
            })

            const response = await responsePromise
            expect(response.statusCode).toBe(200)
            expect(response.json()).toEqual({ ok: true })

            expect(listenOrder).toHaveBeenCalledTimes(1)
            expect(enqueueOrder).toHaveBeenCalledTimes(1)
            // #519: the listener must be registered before the resume is enqueued — otherwise an
            // engine response published the instant the job is enqueued reaches no one.
            expect(listenOrder.mock.invocationCallOrder[0]).toBeLessThan(enqueueOrder.mock.invocationCallOrder[0])
        }
        finally {
            addToQueueSpy.mockRestore()
            watcherSpy.mockRestore()
        }
    })

    it('registers the sync listener before enqueueing the resume in the legacy no-waitpoint path too', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)

        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.LOCKED,
        })
        await db.save('flow_version', flowVersion)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.PAUSED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', { ...flowRun, pauseMetadata: legacyWebhookPauseMetadata() })

        const listenOrder = vi.fn()
        const enqueueOrder = vi.fn()

        const originalAddToQueue = flowRunServiceModule.addToQueue
        const addToQueueSpy = vi.spyOn(flowRunServiceModule, 'addToQueue').mockImplementation(async (params, log) => {
            enqueueOrder()
            return originalAddToQueue(params, log)
        })

        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        listenOrder()
                        return real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                    },
                }
            })

        try {
            // No waitpoint exists for this run, so this hits legacySyncResume, not
            // handleSyncResumeFlow — the reorder needs its own coverage in that branch.
            const responsePromise = app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/requests/${apId()}/sync`,
                body: { data: 'test' },
            })

            const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: flowRun.id })
            const workerHandlerId = engineResponseWatcher(app.log).getServerId()
            await createHandlers(app.log).sendFlowResponse({
                workerHandlerId,
                httpRequestId,
                runResponse: { status: 200, body: { ok: true }, headers: {} },
            })

            const response = await responsePromise
            expect(response.statusCode).toBe(200)
            expect(response.json()).toEqual({ ok: true })

            expect(listenOrder).toHaveBeenCalledTimes(1)
            expect(enqueueOrder).toHaveBeenCalledTimes(1)
            expect(listenOrder.mock.invocationCallOrder[0]).toBeLessThan(enqueueOrder.mock.invocationCallOrder[0])
        }
        finally {
            addToQueueSpy.mockRestore()
            watcherSpy.mockRestore()
        }
    })

    it('cancels the sync listener when the resume turns out to be stale, instead of leaving it to expire on the timeout', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })
        const waitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpoint).not.toBeNull()

        // Resolve the waitpoint through the async route first so the sync request below always
        // finds it already gone — the 410 branch does not depend on this timing, only on the
        // waitpoint no longer existing.
        const firstResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}`,
            body: { status: 'success' },
        })
        expect(firstResponse.statusCode).toBe(200)

        const cancelSpies: (() => void)[] = []
        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        const registration = real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                        const cancelSpy = vi.fn(registration.cancel)
                        cancelSpies.push(cancelSpy)
                        return { ...registration, cancel: cancelSpy }
                    },
                }
            })

        try {
            const secondResponse = await app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}/sync`,
                body: { status: 'success' },
            })

            expect(secondResponse.statusCode).toBe(410)
            expect(secondResponse.json()).toEqual({
                message: 'This link has expired. The action may have already been processed.',
            })
            expect(cancelSpies).toHaveLength(1)
            expect(cancelSpies[0]).toHaveBeenCalledTimes(1)
        }
        finally {
            watcherSpy.mockRestore()
        }
    })

    it('cancels the sync listener when enqueueing the resume fails', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })
        const waitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpoint).not.toBeNull()

        const cancelSpies: (() => void)[] = []
        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        const registration = real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                        const cancelSpy = vi.fn(registration.cancel)
                        cancelSpies.push(cancelSpy)
                        return { ...registration, cancel: cancelSpy }
                    },
                }
            })
        const addToQueueSpy = vi.spyOn(flowRunServiceModule, 'addToQueue').mockRejectedValueOnce(new Error('enqueue boom'))

        try {
            const response = await app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}/sync`,
                body: { status: 'success' },
            })

            expect(response.statusCode).toBe(500)
            expect(cancelSpies).toHaveLength(1)
            expect(cancelSpies[0]).toHaveBeenCalledTimes(1)
        }
        finally {
            addToQueueSpy.mockRestore()
            watcherSpy.mockRestore()
        }
    })

    it('two concurrent sync requests to the same waitpoint on one server: winner gets the engine\'s body, loser gets 410', async () => {
        const { flowRun } = await createPausedFlowRunWithWaitpoint({
            projectId: ctx.project.id,
        })
        const waitpoint = await db.findOneBy<{ id: string }>('waitpoint', { flowRunId: flowRun.id })
        expect(waitpoint).not.toBeNull()

        // #518: waitpointId is unique per waitpoint, not per request — a duplicate/retried
        // request (double-click, client retry, link-scanner prefetch) hitting the same waitpoint
        // must not collide with the original request's listener. Capture the requestId each sync
        // request registers under, the same way the stale-cancel test captures cancel(), so a
        // regression back to the shared waitpointId key is caught directly by asserting two
        // distinct keys — not only indirectly, and only when the pessimistic-lock loser happens
        // to register second.
        const capturedRequestIds: string[] = []
        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        capturedRequestIds.push(requestId)
                        return real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                    },
                }
            })

        try {
            const responseAPromise = app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}/sync`,
                body: { data: 'A' },
            })
            const responseBPromise = app.inject({
                method: 'POST',
                url: `/api/v1/flow-runs/${flowRun.id}/waitpoints/${waitpoint!.id}/sync`,
                body: { data: 'B' },
            })

            // Only the request that wins the pessimistic lock on the waitpoint row enqueues a
            // resume job (id'd by flowRunId) — the loser finds the row already gone and returns
            // 410 without enqueueing anything, so exactly one job is ever queued for this run.
            const httpRequestId = await waitForResumeJobHttpRequestId({ flowRunId: flowRun.id })
            const workerHandlerId = engineResponseWatcher(app.log).getServerId()
            await createHandlers(app.log).sendFlowResponse({
                workerHandlerId,
                httpRequestId,
                runResponse: { status: 200, body: { winner: true }, headers: {} },
            })

            // A regression back to keying by waitpointId (shared across both requests) leaves one
            // of these two requests waiting on a listener the other one owns, which only resolves
            // after the full WEBHOOK_TIMEOUT_MS. Race against a short timeout so that regression
            // fails fast and deterministically instead of eating vitest's own 60s test timeout.
            const raceTimeoutMs = 15000
            const timedOut = Symbol('timed out')
            const raceResult = await Promise.race([
                Promise.all([responseAPromise, responseBPromise]),
                new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), raceTimeoutMs)),
            ])
            if (raceResult === timedOut) {
                throw new Error(`Timed out after ${raceTimeoutMs}ms waiting for both sync responses — likely a listener key collision`)
            }
            const [responseA, responseB] = raceResult

            expect(capturedRequestIds).toHaveLength(2)
            expect(new Set(capturedRequestIds).size).toBe(2)

            const responses = [responseA, responseB]
            const winnerResponse = responses.find((response) => response.statusCode === 200)
            const loserResponse = responses.find((response) => response.statusCode === 410)

            expect(winnerResponse).toBeDefined()
            expect(loserResponse).toBeDefined()
            expect(winnerResponse!.json()).toEqual({ winner: true })
            expect(loserResponse!.json()).toEqual({
                message: 'This link has expired. The action may have already been processed.',
            })

            const waitpointAfter = await db.findOneBy('waitpoint', { flowRunId: flowRun.id })
            expect(waitpointAfter).toBeNull()
        }
        finally {
            watcherSpy.mockRestore()
        }
    })

    it('a listener\'s timeout does not delete a different listener since registered under the same key', async () => {
        const watcher = engineResponseWatcher(app.log)
        const requestId = apId()

        const { promise: firstPromise } = watcher.oneTimeListener<string>(requestId, true, 50, 'first-timed-out')
        // Register a second listener under the same key while the first is still pending, the
        // way a reused/collided key would — the second registration replaces the map entry.
        await new Promise((resolve) => setTimeout(resolve, 20))
        const { promise: secondPromise } = watcher.oneTimeListener<string>(requestId, true, 5000, 'second-timed-out')

        // Let the first listener's own 50ms timeout fire. Without an "am I still the owner"
        // guard this unconditionally deletes the map entry, destroying the second listener too.
        expect(await firstPromise).toBe('first-timed-out')

        await pubsub.publish(`engine-run:sync:${watcher.getServerId()}`, JSON.stringify({
            requestId,
            response: 'second-response',
        }))
        expect(await secondPromise).toBe('second-response')
    })
})

type WaitForConditionParams = {
    fn: () => Promise<boolean>
    timeoutMs?: number
}
