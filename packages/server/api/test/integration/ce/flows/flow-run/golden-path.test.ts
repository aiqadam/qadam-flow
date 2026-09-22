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
 * Uses the async webhook endpoints and polls the run to completion. Two cases
 * are sync on purpose: these flows emit no "respond", so the engine must still
 * answer a finished run straight away (204), and a run that outlives the
 * timeout must get the watcher's 504 rather than a success-shaped answer.
 *
 * Prerequisites:
 *   - Engine must be built (cache/<version>/common/main.js)
 *   - bun must be available for piece installation
 */
import { FlowActionType, FlowOperationType, FlowRunStatus, FlowTriggerType, FlowVersionState, PackageType, PopulatedFlow, QadamType, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { worker } from '../../../../../../worker/src/lib/worker'
import { flowRunService, WEBHOOK_TIMEOUT_MS } from '../../../../../src/app/flows/flow-run/flow-run-service'
import { WebhookFlowVersionToRun, webhookService } from '../../../../../src/app/webhooks/webhook.service'
import { db } from '../../../../helpers/db'
import { setupE2eEnvironment } from '../../../../helpers/e2e-setup'
import { createMockQadamMetadata } from '../../../../helpers/mocks'
import { createTestContext } from '../../../../helpers/test-context'
import { workerSuiteTeardown } from '../../../../helpers/worker-teardown'

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
    await workerSuiteTeardown.run({ app })
}, workerSuiteTeardown.timeoutMs)

async function saveWebhookQadamMetadata(): Promise<void> {
    const webhookPiece = createMockQadamMetadata({
        name: '@aiqadam/qadam-webhook',
        version: '0.1.34',
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

/**
 * Webhook trigger + one code step, published. Deliberately has no respond step: the sync route's
 * answer for it is exactly the "finished, nothing to say" case.
 */
async function createPublishedEchoFlow({ ctx }: { ctx: Awaited<ReturnType<typeof createTestContext>> }): Promise<PopulatedFlow> {
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
    return publishedFlow
}

describe('Golden-path API journey', () => {
    it('create flow → webhook trigger → code action → publish → POST sync webhook → run SUCCEEDED', async () => {
        await saveWebhookQadamMetadata()
        const ctx = await createTestContext(app)

        const flow = await createPublishedEchoFlow({ ctx })

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
            expect.objectContaining({ success: true, message: 'no message' }),
        )
    }, 120_000)

    it('answers a sync webhook on a flow with no respond step with an immediate 204, not the timeout', async () => {
        await saveWebhookQadamMetadata()
        const ctx = await createTestContext(app)
        const flow = await createPublishedEchoFlow({ ctx })

        const startedAt = Date.now()
        const webhookResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flow.id}/sync`,
            headers: { 'content-type': 'application/json' },
            payload: { message: 'hello world' },
        })

        // The engine answers a finished run with 204; the watcher's own timeout default is 504 (#509).
        // The elapsed bound catches the old behaviour too, where the same 204 came only after the wait.
        expect(webhookResponse.statusCode).toBe(StatusCodes.NO_CONTENT)
        expect(webhookResponse.body).toBe('')
        expect(Date.now() - startedAt).toBeLessThan(WEBHOOK_TIMEOUT_MS)

        const flowRunId = await waitForFirstFlowRunId({ ctx, flowId: flow.id })
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })
        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
    }, 120_000)

    it('answers a sync webhook that outlives its timeout with a 504 that invites no retry and names no run', async () => {
        await saveWebhookQadamMetadata()
        const ctx = await createTestContext(app)
        const flow = await createPublishedEchoFlow({ ctx })

        // No engine answers within 1 ms, so this is the watcher's own default and nothing else.
        const response = await webhookService.handleWebhook({
            flowId: flow.id,
            async: false,
            saveSampleData: false,
            flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
            data: async () => ({
                body: { message: 'hello world' },
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                queryParams: {},
            }),
            logger: app.log,
            execute: true,
            failParentOnFailure: false,
            timeoutMs: 1,
        })

        expect(response.status).toBe(StatusCodes.GATEWAY_TIMEOUT)
        expect(response.body).toEqual({
            message: 'The flow run did not respond within the time limit. It may still be running.',
        })
        expect(Object.keys(response.headers)).toEqual(['x-webhook-id'])

        // The 504 says the run may still be going; it must, and must finish on its own.
        const flowRunId = await waitForFirstFlowRunId({ ctx, flowId: flow.id })
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })
        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
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
            expect.objectContaining({ success: true, message: 'no message' }),
        )
    }, 120_000)
})
