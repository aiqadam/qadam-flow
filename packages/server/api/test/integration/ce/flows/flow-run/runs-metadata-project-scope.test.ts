/**
 * The runs-metadata drain writes a run's row only in the project the metadata names (#512). An
 * update naming another project must neither rewrite an existing run (its projectId included) nor
 * create a row pointing at a flow that project does not own.
 */
import { apId, FlowRunStatus, FlowVersionState, RunEnvironment, WebsocketClientEvent } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { websocketService } from '../../../../../src/app/core/websockets.service'
import { distributedStore } from '../../../../../src/app/database/redis-connections'
import { runsMetadataQueue } from '../../../../../src/app/flows/flow-run/flow-runs-queue'
import { redisMetadataKey, RunsMetadataUpsertData } from '../../../../../src/app/workers/job'
import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

async function waitForCondition({ fn, timeoutMs = 10000 }: WaitForConditionParams): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('waitForCondition timed out')
}

async function waitForMetadataConsumed({ runId }: { runId: string }): Promise<void> {
    await waitForCondition({
        fn: async () => {
            const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(runId))
            return pending === null || Object.keys(pending).length === 0
        },
    })
}

let app: FastifyInstance
let owner: TestContext
let other: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    owner = await createTestContext(app)
    other = await createTestContext(app)
})

afterEach(() => {
    vi.restoreAllMocks()
})

// Filtered by run id: a job left over from an earlier test can still emit for its own run.
function recordRunProgressEvents({ runId }: { runId: string }): RecordedEmit[] {
    const recorded: RecordedEmit[] = []
    vi.spyOn(websocketService, 'to').mockImplementation(((room: string) => ({
        emit: (event: string, payload: { runId?: string }): boolean => {
            if (event === WebsocketClientEvent.FLOW_RUN_PROGRESS && payload.runId === runId) {
                // Read at emit time, so an emit sent before the row write would see the old status.
                const statusAtEmit = db.findOneBy<{ status: string }>('flow_run', { id: runId }).then((run) => run?.status)
                recorded.push({ room, payload, statusAtEmit })
            }
            return true
        },
    })) as any)
    return recorded
}

async function createOwnerFlow(): Promise<{ flowId: string, flowVersionId: string }> {
    const flow = createMockFlow({ projectId: owner.project.id })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    return { flowId: flow.id, flowVersionId: flowVersion.id }
}

async function createOwnerRun(): Promise<{ runId: string }> {
    const { flowId, flowVersionId } = await createOwnerFlow()
    const flowRun = createMockFlowRun({
        projectId: owner.project.id,
        flowId,
        flowVersionId,
        status: FlowRunStatus.RUNNING,
        logsFileId: null,
        environment: RunEnvironment.PRODUCTION,
    })
    await db.save('flow_run', flowRun)
    return { runId: flowRun.id }
}

function pendingRunMetadata({ runId, projectId, flowId, flowVersionId }: PendingRunMetadataParams): RunsMetadataUpsertData {
    const now = new Date().toISOString()
    return {
        id: runId,
        projectId,
        flowId,
        flowVersionId,
        environment: RunEnvironment.PRODUCTION,
        status: FlowRunStatus.QUEUED,
        failParentOnFailure: true,
        created: now,
        updated: now,
        tags: [],
    }
}

describe('Runs metadata project scope (#512)', () => {
    it('does not move or rewrite a run when the update names another project', async () => {
        const { runId } = await createOwnerRun()

        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: other.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })
        await waitForMetadataConsumed({ runId })

        const run = await db.findOneBy<{ projectId: string, status: string }>('flow_run', { id: runId })
        expect(run?.projectId).toBe(owner.project.id)
        expect(run?.status).toBe(FlowRunStatus.RUNNING)
    })

    it('still applies an update that names the run\'s own project', async () => {
        const { runId } = await createOwnerRun()

        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: owner.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ status: string }>('flow_run', { id: runId })
                return run?.status === FlowRunStatus.SUCCEEDED
            },
        })
    })

    // #580: the run view refetches on FLOW_RUN_PROGRESS, so it must name only the run's own project,
    // and only once the row it will read has been written.
    it('tells the run\'s own project room once the update is stored', async () => {
        const { runId } = await createOwnerRun()
        const recorded = recordRunProgressEvents({ runId })

        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: owner.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })
        await waitForCondition({ fn: async () => recorded.length > 0 })

        expect(recorded.map(({ room, payload }) => ({ room, payload }))).toEqual([{ room: owner.project.id, payload: { runId } }])
        expect(await recorded[0].statusAtEmit).toBe(FlowRunStatus.SUCCEEDED)
    })

    // The metadata worker starts before socket.io is registered, so the emit throws during boot. The
    // snapshot is already consumed by then: a throw ahead of the finish side effects drops them.
    it('still runs the finish side effects when the progress notification throws', async () => {
        const { runId } = await createOwnerRun()
        await db.save('waitpoint', {
            id: apId(),
            flowRunId: runId,
            projectId: owner.project.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            status: 'PENDING',
            httpRequestId: null,
            workerHandlerId: null,
        })
        vi.spyOn(websocketService, 'to').mockImplementation(() => {
            throw new TypeError('Cannot read properties of undefined (reading \'to\')')
        })

        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: owner.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })

        await waitForCondition({
            fn: async () => (await db.findOneBy('waitpoint', { flowRunId: runId })) === null,
        })
    })

    it('tells no project room about an update that names another project', async () => {
        const { runId } = await createOwnerRun()
        const recorded = recordRunProgressEvents({ runId })

        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: other.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })
        await waitForMetadataConsumed({ runId })
        // The hash is consumed before the drain emits, so an empty list here alone could be a race.
        // Updates for one run drain one at a time under its lock: once this one has emitted, the
        // foreign one is done. Only this one moves the row to SUCCEEDED, so an emit made for the
        // foreign one, whatever room it names, shows up as a second entry.
        await createHandlers(app.log).uploadRunLog({
            runId,
            projectId: owner.project.id,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })
        await waitForCondition({
            fn: async () => (await Promise.all(recorded.map(({ statusAtEmit }) => statusAtEmit))).includes(FlowRunStatus.SUCCEEDED),
        })

        expect(recorded.map(({ room, payload }) => ({ room, payload }))).toEqual([{ room: owner.project.id, payload: { runId } }])
    })

    it('does not take over another project\'s run through a pending-run upsert', async () => {
        const { runId } = await createOwnerRun()
        const otherFlow = createMockFlow({ projectId: other.project.id })
        await db.save('flow', otherFlow)
        const otherFlowVersion = createMockFlowVersion({ flowId: otherFlow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', otherFlowVersion)

        await runsMetadataQueue(app.log).add(pendingRunMetadata({ runId, projectId: other.project.id, flowId: otherFlow.id, flowVersionId: otherFlowVersion.id }))
        await waitForMetadataConsumed({ runId })

        const run = await db.findOneBy<{ projectId: string, status: string }>('flow_run', { id: runId })
        expect(run?.projectId).toBe(owner.project.id)
        expect(run?.status).toBe(FlowRunStatus.RUNNING)
    })

    it('does not create a run in one project for a flow owned by another', async () => {
        const { flowId, flowVersionId } = await createOwnerFlow()
        const runId = apId()

        await runsMetadataQueue(app.log).add(pendingRunMetadata({ runId, projectId: other.project.id, flowId, flowVersionId }))
        await waitForMetadataConsumed({ runId })

        const run = await db.findOneBy<{ id: string }>('flow_run', { id: runId })
        expect(run).toBeNull()
    })

    it('creates a pending run whose flow belongs to the project it names', async () => {
        const { flowId, flowVersionId } = await createOwnerFlow()
        const runId = apId()

        await runsMetadataQueue(app.log).add(pendingRunMetadata({ runId, projectId: owner.project.id, flowId, flowVersionId }))

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ projectId: string }>('flow_run', { id: runId })
                return run?.projectId === owner.project.id
            },
        })
    })
})

type RecordedEmit = {
    room: string
    payload: unknown
    statusAtEmit: Promise<string | undefined>
}

type WaitForConditionParams = {
    fn: () => Promise<boolean>
    timeoutMs?: number
}

type PendingRunMetadataParams = {
    runId: string
    projectId: string
    flowId: string
    flowVersionId: string
}
