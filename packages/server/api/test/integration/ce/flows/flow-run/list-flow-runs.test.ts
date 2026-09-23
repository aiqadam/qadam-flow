import { FlowRunStatus, FlowVersionState, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { db } from '../../../../helpers/db'
import { describeWithAuth } from '../../../../helpers/describe-with-auth'
import { createMockFlow, createMockFlowRun, createMockFlowVersion } from '../../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describeWithAuth('List flow runs endpoint', () => app!, (setup) => {
    it('should return empty list with correct structure', async () => {
        const ctx = await setup()

        const response = await ctx.get('/v1/flow-runs', {
            projectId: ctx.project.id,
        })

        expect(response?.statusCode).toBe(200)
        const body = response?.json()
        expect(body.data).toEqual([])
        expect(body.cursor).toBeUndefined()
    })

    it('resolves dispatchWaitMs to null for a run that has not started yet (#510)', async () => {
        const ctx = await setup()

        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.QUEUED,
            environment: RunEnvironment.PRODUCTION,
        })
        await db.save('flow_run', flowRun)
        // createMockFlowRun's own `?? faker.date...` default treats `null` the same as `undefined`
        // and would fill in a fake startTime, so the "not started yet" state has to be forced onto
        // the row after the initial save instead.
        await db.update('flow_run', flowRun.id, { startTime: null, finishTime: null })

        const response = await ctx.get('/v1/flow-runs', {
            projectId: ctx.project.id,
        })

        expect(response?.statusCode).toBe(200)
        const body = response?.json()
        const returnedRun = body.data.find((run: { id: string }) => run.id === flowRun.id)
        expect(returnedRun).toBeDefined()
        expect(returnedRun.dispatchWaitMs).toBeNull()
    })

    it('resolves dispatchWaitMs to null rather than a negative number when startTime somehow precedes created (#510)', async () => {
        const ctx = await setup()

        const flow = createMockFlow({ projectId: ctx.project.id })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)
        const created = new Date('2024-06-01T00:00:10.000Z').toISOString()
        const startTime = new Date('2024-06-01T00:00:00.000Z').toISOString()
        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            status: FlowRunStatus.RUNNING,
            environment: RunEnvironment.PRODUCTION,
            created,
            startTime,
            finishTime: undefined,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.get('/v1/flow-runs', {
            projectId: ctx.project.id,
        })

        expect(response?.statusCode).toBe(200)
        const body = response?.json()
        const returnedRun = body.data.find((run: { id: string }) => run.id === flowRun.id)
        expect(returnedRun).toBeDefined()
        expect(returnedRun.dispatchWaitMs).toBeNull()
    })
})
