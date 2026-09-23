import { FlowRunStatus, FlowStatus, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../../helpers/mocks'
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

async function createCancellableRun(params: { projectId: string, parentRunId?: string }): Promise<{ id: string }> {
    const flow = createMockFlow({ projectId: params.projectId, status: FlowStatus.ENABLED })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id })
    await db.save('flow_version', flowVersion)
    const run = createMockFlowRun({
        projectId: params.projectId,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: FlowRunStatus.QUEUED,
        environment: RunEnvironment.PRODUCTION,
        parentRunId: params.parentRunId,
    })
    await db.save('flow_run', run)
    return run
}

async function readStatus(runId: string): Promise<FlowRunStatus> {
    const row = await db.findOneByOrFail<{ status: FlowRunStatus }>('flow_run', { id: runId })
    return row.status
}

async function waitForStatus({ runId, expected, timeoutMs = 15_000 }: { runId: string, expected: FlowRunStatus, timeoutMs?: number }): Promise<void> {
    const start = Date.now()
    let last = await readStatus(runId)
    while (last !== expected && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        last = await readStatus(runId)
    }
    expect(last).toBe(expected)
}

describe('POST /v1/flow-runs/cancel does not reach another project (#521)', () => {
    it('does not cancel a child run in another project even when that child names the cancelled run as its parent', async () => {
        const projectId = ctx.project.id
        const { mockProject: otherProject } = await mockAndSaveBasicSetup()

        const ownRun = await createCancellableRun({ projectId })
        // Never legitimately reachable after the #521 ingress fix (a webhook-forged cross-project
        // `parentRunId` is dropped before the run is created) — this row stands in for data that
        // predates the fix, or a bug in some other write path, so `getAllChildRuns` on its own
        // must not walk into it either.
        const foreignChildRun = await createCancellableRun({ projectId: otherProject.id, parentRunId: ownRun.id })

        const response = await ctx.post('/v1/flow-runs/cancel', {
            projectId,
            flowRunIds: [ownRun.id],
        })
        expect(response.statusCode).toBe(200)

        await waitForStatus({ runId: ownRun.id, expected: FlowRunStatus.CANCELED })
        // `ownRun`'s cancel and the (pre-fix, buggy) cross-project descendant cancel would be
        // enqueued in the same batch and drained by the same worker — once the direct target has
        // settled, a bug reaching the foreign row has had every realistic chance to show up too.
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(await readStatus(foreignChildRun.id)).toBe(FlowRunStatus.QUEUED)
    })

    it('still cancels a child run in the same project', async () => {
        const projectId = ctx.project.id
        const ownRun = await createCancellableRun({ projectId })
        const childRun = await createCancellableRun({ projectId, parentRunId: ownRun.id })

        const response = await ctx.post('/v1/flow-runs/cancel', {
            projectId,
            flowRunIds: [ownRun.id],
        })
        expect(response.statusCode).toBe(200)

        await waitForStatus({ runId: ownRun.id, expected: FlowRunStatus.CANCELED })
        await waitForStatus({ runId: childRun.id, expected: FlowRunStatus.CANCELED })
    })
})
