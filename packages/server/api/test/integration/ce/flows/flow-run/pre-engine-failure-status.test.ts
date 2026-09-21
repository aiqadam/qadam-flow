/**
 * Pre-engine failure paths (#434): a run that fails before the engine ever starts
 * reports a logsFileId whose file row was never created. The status write must
 * still land instead of dying on fk_flow_run_logs_file_id and stranding the run
 * at QUEUED forever.
 */
import { apId, FileType, FlowRunStatus, FlowVersionState, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { distributedStore } from '../../../../../src/app/database/redis-connections'
import { fileService } from '../../../../../src/app/file/file.service'
import { runsMetadataQueue } from '../../../../../src/app/flows/flow-run/flow-runs-queue'
import { redisMetadataKey } from '../../../../../src/app/workers/job'
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

async function createQueuedRun(): Promise<{ runId: string }> {
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
        status: FlowRunStatus.QUEUED,
        logsFileId: null,
        environment: RunEnvironment.TESTING,
    })
    await db.save('flow_run', flowRun)
    return { runId: flowRun.id }
}

describe('Pre-engine failure status (#434)', () => {
    it('lands FAILED and creates the logs file when the reported logsFileId was never written', async () => {
        const { runId } = await createQueuedRun()
        const logsFileId = apId()
        const finishTime = new Date().toISOString()

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({
            runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime,
            logsFileId,
        })

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ id: string, status: string }>('flow_run', { id: runId })
                return run?.status === FlowRunStatus.FAILED
            },
        })

        const run = await db.findOneBy<{ id: string, status: string, finishTime: string, logsFileId: string }>('flow_run', { id: runId })
        expect(run?.finishTime).not.toBeNull()
        expect(run?.logsFileId).toBe(logsFileId)

        const fileExists = await fileService(app.log).exists({
            projectId: ctx.project.id,
            fileId: logsFileId,
            type: FileType.FLOW_RUN_LOG,
        })
        expect(fileExists).toBe(true)
    })

    it('lands FAILED without a logs file when the hash carries a dangling logsFileId', async () => {
        const { runId } = await createQueuedRun()
        const danglingLogsFileId = apId()

        await distributedStore.merge(redisMetadataKey(runId), {
            id: runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
            logsFileId: danglingLogsFileId,
        })
        await runsMetadataQueue(app.log).add({ id: runId, projectId: ctx.project.id })

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ id: string, status: string }>('flow_run', { id: runId })
                return run?.status === FlowRunStatus.FAILED
            },
        })

        const run = await db.findOneBy<{ id: string, status: string, logsFileId: string | null }>('flow_run', { id: runId })
        expect(run?.logsFileId).toBeNull()

        const fileExists = await fileService(app.log).exists({
            projectId: ctx.project.id,
            fileId: danglingLogsFileId,
            type: FileType.FLOW_RUN_LOG,
        })
        expect(fileExists).toBe(false)
    })

    it('lands FAILED with no file created when no logsFileId is reported', async () => {
        const { runId } = await createQueuedRun()

        const handlers = createHandlers(app.log)
        await handlers.uploadRunLog({
            runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ id: string, status: string }>('flow_run', { id: runId })
                return run?.status === FlowRunStatus.FAILED
            },
        })

        const run = await db.findOneBy<{ id: string, status: string, logsFileId: string | null }>('flow_run', { id: runId })
        expect(run?.logsFileId).toBeNull()
    })

    // The abandon path, and the reason #500 kept recurring. `processRunsMetadataUpdate` used to
    // return here without consuming the snapshot it had just read, so the re-enqueue at the end of
    // the job saw a non-empty hash and added another job, which abandoned it again — a permanent
    // hot loop, one job every few milliseconds, that saturated the BullMQ worker's main loop and
    // made `Worker.close()` (which awaits it) take up to 29s of the suites' 30s teardown budget.
    //
    // On the unfixed code the hash below never empties and this times out. The sibling case above
    // covers the unconditional delete; this one carries a `requestId`, so it covers the
    // compare-and-delete branch.
    it('consumes the hash when the flow is gone, rather than re-enqueueing forever', async () => {
        const runId = apId()
        const key = redisMetadataKey(runId)

        // No flow_run row, and a flowId no flow owns: `flowService.exists` says no, which is the
        // state every CE suite leaves behind when it truncates between files.
        await distributedStore.merge(key, {
            id: runId,
            projectId: ctx.project.id,
            flowId: apId(),
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
            requestId: apId(),
        })
        await runsMetadataQueue(app.log).get().add(
            'update-run-metadata',
            { runId, projectId: ctx.project.id },
            { deduplication: { id: runId } },
        )

        await waitForCondition({
            fn: async () => {
                const leftover = await distributedStore.hgetJson(key)
                return leftover === null
            },
        })
    })

    it('consumes the hash in one pass when it carries no requestId', async () => {
        const { runId } = await createQueuedRun()
        const key = redisMetadataKey(runId)

        await distributedStore.merge(key, {
            id: runId,
            projectId: ctx.project.id,
            status: FlowRunStatus.FAILED,
            finishTime: new Date().toISOString(),
        })
        await runsMetadataQueue(app.log).get().add(
            'update-run-metadata',
            { runId, projectId: ctx.project.id },
            { deduplication: { id: runId } },
        )

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ id: string, status: string }>('flow_run', { id: runId })
                return run?.status === FlowRunStatus.FAILED
            },
        })
        await waitForCondition({
            fn: async () => {
                const leftover = await distributedStore.hgetJson(key)
                return leftover === null
            },
        })
    })
})

type WaitForConditionParams = {
    fn: () => Promise<boolean>
    timeoutMs?: number
}
