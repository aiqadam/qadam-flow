import { FlowRetryStrategy, FlowRunStatus, FlowVersionState, isNil, PauseType, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { waitpointService } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-service'
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

async function createFailedFlowRun(params: {
    projectId: string
    startTime?: string
    finishTime?: string
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
        status: FlowRunStatus.FAILED,
        environment: RunEnvironment.PRODUCTION,
        startTime: params.startTime,
        finishTime: params.finishTime,
    })
    await db.save('flow_run', flowRun)

    return { flow, flowVersion, flowRun }
}

describe('Retry flow run', () => {
    it('should retry from failed step and transition to queued status', async () => {
        const { flowRun } = await createFailedFlowRun({
            projectId: ctx.project.id,
        })

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, {
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)

        const updatedRun = await db.findOneByOrFail<{ id: string, status: string }>('flow_run', { id: flowRun.id })
        expect(updatedRun.status).toBe(FlowRunStatus.QUEUED)
    })

    it('should reset startTime and clear finishTime when retrying from failed step', async () => {
        const originalStartTime = new Date('2020-01-01T00:00:00.000Z').toISOString()
        const originalFinishTime = new Date('2020-01-01T00:05:00.000Z').toISOString()
        const { flowRun } = await createFailedFlowRun({
            projectId: ctx.project.id,
            startTime: originalStartTime,
            finishTime: originalFinishTime,
        })

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, {
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)

        const updatedRun = await db.findOneByOrFail<{ id: string, startTime: Date | null, finishTime: Date | null }>('flow_run', { id: flowRun.id })
        expect(updatedRun.startTime).not.toBeNull()
        expect(new Date(updatedRun.startTime!).getTime()).toBeGreaterThan(new Date(originalStartTime).getTime())
        expect(updatedRun.finishTime).toBeNull()
    })

    it('should retry on latest version and create a new run', async () => {
        const { flowRun } = await createFailedFlowRun({
            projectId: ctx.project.id,
        })

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, {
            strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.id).not.toBe(flowRun.id)
        expect(body.flowId).toBe(flowRun.flowId)
    })

    it('should copy a re-verified parentWaitpointId forward when retrying ON_LATEST_VERSION (#521)', async () => {
        const parentFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', parentFlow)
        const parentFlowVersion = createMockFlowVersion({ flowId: parentFlow.id })
        await db.save('flow_version', parentFlowVersion)
        const parentRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: parentFlow.id,
            flowVersionId: parentFlowVersion.id,
            status: FlowRunStatus.PAUSED,
        })
        await db.save('flow_run', parentRun)
        const { waitpoint } = await waitpointService(app.log).createForPause({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            callerRunId: parentRun.id,
            stepName: 'callFlow',
            type: PauseType.WEBHOOK,
            version: 'V1',
        })

        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.FAILED,
            environment: RunEnvironment.TESTING,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: waitpoint.id,
        })
        await db.save('flow_run', childRun)

        const response = await ctx.post(`/v1/flow-runs/${childRun.id}/retry`, {
            strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.id).not.toBe(childRun.id)
        expect(body.parentRunId).toBe(parentRun.id)
        expect(body.failParentOnFailure).toBe(true)
        expect(body.parentWaitpointId).toBe(waitpoint.id)
    })

    it('carries inheritedRunLocale forward when retrying ON_LATEST_VERSION (M2)', async () => {
        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.FAILED,
            environment: RunEnvironment.TESTING,
            inheritedRunLocale: 'ru',
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post(`/v1/flow-runs/${flowRun.id}/retry`, {
            strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.id).not.toBe(flowRun.id)
        expect(body.inheritedRunLocale).toBe('ru')
    })

    it('drops a retried run\'s parentWaitpointId when the parent waitpoint no longer re-verifies (already completed)', async () => {
        const parentFlow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', parentFlow)
        const parentFlowVersion = createMockFlowVersion({ flowId: parentFlow.id })
        await db.save('flow_version', parentFlowVersion)
        const parentRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: parentFlow.id,
            flowVersionId: parentFlowVersion.id,
            status: FlowRunStatus.PAUSED,
        })
        await db.save('flow_run', parentRun)
        const { waitpoint } = await waitpointService(app.log).createForPause({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            callerRunId: parentRun.id,
            stepName: 'callFlow',
            type: PauseType.WEBHOOK,
            version: 'V1',
        })
        // Simulates the parent's own waitpoint already having been completed (e.g. by an earlier
        // sibling child) between the original run and this retry.
        await waitpointService(app.log).complete({
            flowRunId: parentRun.id,
            projectId: ctx.project.id,
            waitpointId: waitpoint.id,
            resumePayload: null,
        })

        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const childRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.FAILED,
            environment: RunEnvironment.TESTING,
            parentRunId: parentRun.id,
            failParentOnFailure: true,
            parentWaitpointId: waitpoint.id,
        })
        await db.save('flow_run', childRun)

        const response = await ctx.post(`/v1/flow-runs/${childRun.id}/retry`, {
            strategy: FlowRetryStrategy.ON_LATEST_VERSION,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.parentRunId).toBe(parentRun.id)
        expect(body.failParentOnFailure).toBe(false)
        // `resolveVerifiedParent` returns `undefined`, but the field round-trips through a
        // nullable Postgres column via `flowRunRepo().save()`, so the serialized response holds
        // `null` rather than an absent key — `isNil` treats both as "not verified" here.
        expect(isNil(body.parentWaitpointId)).toBe(true)
    })

    it('should return 400 for invalid flow run id', async () => {
        const response = await ctx.post('/v1/flow-runs/non-existent-id/retry', {
            strategy: FlowRetryStrategy.FROM_FAILED_STEP,
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(400)
    })
})
