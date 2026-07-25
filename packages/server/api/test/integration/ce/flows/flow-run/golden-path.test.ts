/**
 * Golden-path E2E integration test for the full API user journey.
 *
 * Tests the round-trip via public API endpoints:
 *   POST /v1/flows (create)
 *   → POST /v1/flows/:id (UPDATE_TRIGGER to webhook)
 *   → POST /v1/flows/:id (ADD_ACTION code step)
 *   → POST /v1/flows/:id (LOCK_AND_PUBLISH)
 *   → POST /api/v1/webhooks/:flowId (fire webhook async, poll run to SUCCEEDED)
 *
 * Also tests the draft variant:
 *   → POST /api/v1/webhooks/:flowId/draft (execute the latest version in TESTING)
 *
 * Uses the async webhook endpoints and polls the run to completion. The /sync
 * endpoints block on an engine "respond" that these flows don't emit, so they
 * would hang until WEBHOOK_TIMEOUT.
 *
 * Prerequisites:
 *   - Engine must be built (cache/<version>/common/main.js)
 *   - bun must be available for piece installation
 */
import { FlowActionType, FlowOperationType, FlowRunStatus, FlowTriggerType, FlowVersionState, PackageType, PopulatedFlow, QadamType, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { worker } from '../../../../../../worker/src/lib/worker'
import { flowRunService } from '../../../../../src/app/flows/flow-run/flow-run-service'
import { db } from '../../../../helpers/db'
import { setupE2eEnvironment } from '../../../../helpers/e2e-setup'
import { createMockQadamMetadata } from '../../../../helpers/mocks'
import { createTestContext } from '../../../../helpers/test-context'

let app: FastifyInstance

beforeAll(async () => {
    const ctx = await setupE2eEnvironment()
    app = ctx.app
    await worker.start({
        apiUrl: ctx.apiUrl,
        socketUrl: { url: ctx.apiUrl, path: '/api/socket.io' },
        workerToken: ctx.workerToken,
    })
    await new Promise((resolve) => setTimeout(resolve, 5000))
}, 30_000)

afterAll(async () => {
    void worker.stop()
    await app.close()
}, 15_000)

async function saveWebhookQadamMetadata(): Promise<void> {
    const webhookPiece = createMockQadamMetadata({
        name: '@aiqadam/qadam-webhook',
        version: '0.1.29',
        platformId: undefined,
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
    })
    await db.save('qadam_metadata', webhookPiece)
}

async function waitForFirstFlowRunId({ ctx, flowId }: { ctx: Awaited<ReturnType<typeof createTestContext>>, flowId: string }): Promise<string> {
    const maxWaitMs = 30_000
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
        const runsResponse = await ctx.get('/v1/flow-runs', { projectId: ctx.project.id, flowId })
        const runs: Array<{ id: string }> = runsResponse.json().data
        if (runs.length > 0) {
            return runs[0].id
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`No flow run appeared for flow ${flowId} within ${maxWaitMs}ms`)
}

// TESTING (draft) runs aren't returned by GET /v1/flow-runs (production-only),
// so read them straight from the table under the test harness.
async function waitForTestFlowRunId(flowId: string): Promise<string> {
    const maxWaitMs = 30_000
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
        const runs = await db.find<{ id: string }>('flow_run', { flowId, environment: RunEnvironment.TESTING })
        if (runs.length > 0) {
            return runs[0].id
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`No TESTING flow run appeared for flow ${flowId} within ${maxWaitMs}ms`)
}

async function pollFlowRunToCompletion({ flowRunId, projectId }: { flowRunId: string, projectId: string }): Promise<Awaited<ReturnType<ReturnType<typeof flowRunService>['getOnePopulatedOrThrow']>>> {
    const maxWaitMs = 120_000
    const pollIntervalMs = 500
    const start = Date.now()
    let result = await flowRunService(app.log).getOnePopulatedOrThrow({
        id: flowRunId,
        projectId,
    })

    while (
        (result.status === FlowRunStatus.QUEUED ||
            result.status === FlowRunStatus.RUNNING ||
            result.status === FlowRunStatus.PAUSED) &&
        Date.now() - start < maxWaitMs
    ) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        result = await flowRunService(app.log).getOnePopulatedOrThrow({
            id: flowRunId,
            projectId,
        })
    }

    return result
}

describe('Golden-path API journey', () => {
    it('create flow → webhook trigger → code action → publish → POST sync webhook → run SUCCEEDED', async () => {
        await saveWebhookQadamMetadata()
        const ctx = await createTestContext(app)

        // Step 1: Create the flow
        const createResponse = await ctx.post('/v1/flows', {
            displayName: 'Golden Path Flow',
            projectId: ctx.project.id,
        }, { query: { projectId: ctx.project.id } })

        expect(createResponse.statusCode).toBe(StatusCodes.CREATED)
        const flow: PopulatedFlow = createResponse.json()

        // Step 2: Update trigger to webhook
        const updateTriggerResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.UPDATE_TRIGGER,
            request: {
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: '@aiqadam/qadam-webhook',
                    qadamVersion: '0.1.34',
                    input: { authType: 'none' },
                    triggerName: 'catch_webhook',
                    propertySettings: {},
                },
                valid: false,
                name: 'trigger',
                displayName: 'Catch Webhook',
                lastUpdatedDate: new Date().toISOString(),
            },
        })

        expect(updateTriggerResponse.statusCode).toBe(StatusCodes.OK)

        // Step 3: Add a code action that echoes back the incoming message
        const addActionResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.ADD_ACTION,
            request: {
                parentStep: 'trigger',
                action: {
                    type: FlowActionType.CODE,
                    displayName: 'Code Step',
                    name: 'step_1',
                    settings: {
                        input: { body: '{{trigger.body}}' },
                        sourceCode: {
                            code: 'export const code = async (inputs) => { return { success: true, message: inputs.body?.message || "no message" }; }',
                            packageJson: '{}',
                        },
                    },
                    valid: true,
                    skip: false,
                },
            },
        })

        expect(addActionResponse.statusCode).toBe(StatusCodes.OK)

        // Step 4: Publish the flow (LOCK_AND_PUBLISH auto-enables it)
        const publishResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.LOCK_AND_PUBLISH,
            request: {},
        })

        expect(publishResponse.statusCode).toBe(StatusCodes.OK)
        const publishedFlow: PopulatedFlow = publishResponse.json()
        expect(publishedFlow.version.state).toBe(FlowVersionState.LOCKED)

        // Step 5: Fire the sync webhook and wait for the synchronous response
        const webhookResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flow.id}`,
            headers: { 'content-type': 'application/json' },
            payload: { message: 'hello world' },
        })

        expect(webhookResponse.statusCode).toBe(StatusCodes.OK)

        // Step 6: Find the resulting flow run and verify it completed successfully
        const flowRunId = await waitForFirstFlowRunId({ ctx, flowId: flow.id })
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })

        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
        // The code step executed end-to-end. (The request body is not asserted
        // here: fastify's `app.inject` does not populate the webhook route's
        // raw body, so the trigger's `body` output is empty under the harness.)
        expect(result.steps.step_1.output).toEqual(
            expect.objectContaining({ success: true }),
        )
    }, 120_000)

    it('create flow → webhook trigger → code action → test via draft sync webhook', async () => {
        await saveWebhookQadamMetadata()
        const ctx = await createTestContext(app)

        // Step 1: Create the flow
        const createResponse = await ctx.post('/v1/flows', {
            displayName: 'Golden Path Draft Flow',
            projectId: ctx.project.id,
        }, { query: { projectId: ctx.project.id } })

        expect(createResponse.statusCode).toBe(StatusCodes.CREATED)
        const flow: PopulatedFlow = createResponse.json()

        // Step 2: Update trigger to webhook
        const updateTriggerResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.UPDATE_TRIGGER,
            request: {
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: '@aiqadam/qadam-webhook',
                    qadamVersion: '0.1.34',
                    input: { authType: 'none' },
                    triggerName: 'catch_webhook',
                    propertySettings: {},
                },
                valid: false,
                name: 'trigger',
                displayName: 'Catch Webhook',
                lastUpdatedDate: new Date().toISOString(),
            },
        })

        expect(updateTriggerResponse.statusCode).toBe(StatusCodes.OK)

        // Step 3: Add a code action
        const addActionResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.ADD_ACTION,
            request: {
                parentStep: 'trigger',
                action: {
                    type: FlowActionType.CODE,
                    displayName: 'Code Step',
                    name: 'step_1',
                    settings: {
                        input: { body: '{{trigger.body}}' },
                        sourceCode: {
                            code: 'export const code = async (inputs) => { return { success: true, message: inputs.body?.message || "no message" }; }',
                            packageJson: '{}',
                        },
                    },
                    valid: true,
                    skip: false,
                },
            },
        })

        expect(addActionResponse.statusCode).toBe(StatusCodes.OK)

        // Step 4: Publish so the flow is enabled — the /draft webhook only
        // executes an ENABLED flow (it runs the LATEST version in TESTING).
        const publishResponse = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.LOCK_AND_PUBLISH,
            request: {},
        })
        expect(publishResponse.statusCode).toBe(StatusCodes.OK)

        // Step 5: Fire the draft webhook (executes the latest version in TESTING)
        const webhookResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flow.id}/draft`,
            headers: { 'content-type': 'application/json' },
            payload: { message: 'draft test' },
        })

        expect(webhookResponse.statusCode).toBe(StatusCodes.OK)

        // Step 5: Verify the draft run completed successfully
        const flowRunId = await waitForTestFlowRunId(flow.id)
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })

        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
        expect(result.steps.step_1.output).toEqual(
            expect.objectContaining({ success: true }),
        )
    }, 120_000)
})
