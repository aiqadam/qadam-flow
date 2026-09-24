/**
 * A DELAY waitpoint's job can fire before its run has reported PAUSED — a durable loop's budget
 * checkpoint (#387) is due at once. The job must still leave something that resumes the run once the
 * PAUSED upload lands; a skipped job and a PENDING waitpoint would leave it PAUSED for good.
 */
import { FlowRunStatus, FlowVersionState, PauseType, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { resumeService } from '../../../../../src/app/flows/flow-run/waitpoint/resume-service'
import { waitpointService } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-service'
import { WaitpointStatus } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-types'
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

describe('DELAY waitpoint due while its run is still RUNNING', () => {
    it('is completed by its job and resumed by the PAUSED upload', async () => {
        const flowRun = await createRunningFlowRun()
        const { waitpoint } = await waitpointService(app.log).createForPause({
            flowRunId: flowRun.id,
            callerRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'loop',
            type: PauseType.DELAY,
            version: 'V1',
            resumeDateTime: new Date().toISOString(),
        })

        await resumeService(app.log).resumeDelayWaitpoint({ flowRunId: flowRun.id, projectId: ctx.project.id, waitpointId: waitpoint.id })

        const completed = await db.findOneBy<{ status: string }>('waitpoint', { id: waitpoint.id })
        expect(completed?.status).toBe(WaitpointStatus.COMPLETED)

        await createHandlers(app.log).uploadRunLog({
            runId: flowRun.id,
            projectId: ctx.project.id,
            status: FlowRunStatus.PAUSED,
        })

        await waitForCondition({
            fn: async () => (await db.findOneBy('waitpoint', { id: waitpoint.id })) === null,
        })
    })

    it('is dropped as stale once its run has finished', async () => {
        const flowRun = await createRunningFlowRun({ status: FlowRunStatus.SUCCEEDED })
        const { waitpoint } = await waitpointService(app.log).createForPause({
            flowRunId: flowRun.id,
            callerRunId: flowRun.id,
            projectId: ctx.project.id,
            stepName: 'loop',
            type: PauseType.DELAY,
            version: 'V1',
            resumeDateTime: new Date().toISOString(),
        })

        await resumeService(app.log).resumeDelayWaitpoint({ flowRunId: flowRun.id, projectId: ctx.project.id, waitpointId: waitpoint.id })

        const untouched = await db.findOneBy<{ status: string }>('waitpoint', { id: waitpoint.id })
        expect(untouched?.status).toBe(WaitpointStatus.PENDING)
    })
})

async function createRunningFlowRun(params?: { status?: FlowRunStatus }): Promise<{ id: string }> {
    const flow = createMockFlow({ projectId: ctx.project.id })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    const flowRun = createMockFlowRun({
        projectId: ctx.project.id,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: params?.status ?? FlowRunStatus.RUNNING,
        environment: RunEnvironment.PRODUCTION,
    })
    await db.save('flow_run', flowRun)
    return flowRun
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
