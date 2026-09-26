/**
 * `RunsMetadataUpsertData` only carries a fixed allow-list of fields through the runs-metadata
 * queue into the `flow_run` row (`stripToRunsMetadataUpsertData`); `inheritedRunLocale` was missing
 * from it, so a PRODUCTION-environment run (the only environment that goes through this queue -
 * TESTING writes the row directly) created by a queued subflow lost its inherited locale the moment
 * it was first persisted, even though `queueOrCreateInstantly` built the in-memory `FlowRun` object
 * with the real value.
 */
import { apId, FlowRunStatus, FlowVersionState, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { distributedStore } from '../../../../../src/app/database/redis-connections'
import { runsMetadataQueue } from '../../../../../src/app/flows/flow-run/flow-runs-queue'
import { redisMetadataKey, RunsMetadataUpsertData } from '../../../../../src/app/workers/job'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

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

let app: FastifyInstance
let owner: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    owner = await createTestContext(app)
})

async function createOwnerFlow(): Promise<{ flowId: string, flowVersionId: string }> {
    const flow = createMockFlow({ projectId: owner.project.id })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    return { flowId: flow.id, flowVersionId: flowVersion.id }
}

describe('Runs metadata carries inheritedRunLocale through a PRODUCTION creation flush', () => {
    it('persists inheritedRunLocale on the flow_run row created via the queue', async () => {
        const { flowId, flowVersionId } = await createOwnerFlow()
        const runId = apId()
        const now = new Date().toISOString()
        const pendingRun: RunsMetadataUpsertData = {
            id: runId,
            projectId: owner.project.id,
            flowId,
            flowVersionId,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.QUEUED,
            failParentOnFailure: true,
            created: now,
            updated: now,
            tags: [],
            inheritedRunLocale: 'ru',
        }

        await runsMetadataQueue(app.log).add(pendingRun)

        await waitForCondition({
            fn: async () => {
                const pending = await distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(runId))
                return pending === null || Object.keys(pending).length === 0
            },
        })

        const run = await db.findOneBy<{ inheritedRunLocale: string | null }>('flow_run', { id: runId })
        expect(run?.inheritedRunLocale).toBe('ru')
    })

    it('leaves inheritedRunLocale null for a top-level run that never inherited one', async () => {
        const { flowId, flowVersionId } = await createOwnerFlow()
        const runId = apId()
        const now = new Date().toISOString()
        const pendingRun: RunsMetadataUpsertData = {
            id: runId,
            projectId: owner.project.id,
            flowId,
            flowVersionId,
            environment: RunEnvironment.PRODUCTION,
            status: FlowRunStatus.QUEUED,
            failParentOnFailure: true,
            created: now,
            updated: now,
            tags: [],
        }

        await runsMetadataQueue(app.log).add(pendingRun)

        await waitForCondition({
            fn: async () => {
                const run = await db.findOneBy<{ projectId: string }>('flow_run', { id: runId })
                return run?.projectId === owner.project.id
            },
        })

        const run = await db.findOneBy<{ inheritedRunLocale: string | null }>('flow_run', { id: runId })
        expect(run?.inheritedRunLocale).toBeNull()
    })
})
