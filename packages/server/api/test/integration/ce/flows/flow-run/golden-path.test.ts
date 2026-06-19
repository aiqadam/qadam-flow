/**
 * Golden-path E2E integration test for the full API user journey.
 *
 * Tests the round-trip via public API endpoints:
 *   POST /v1/flows (create)
 *   → POST /v1/flows/:id (UPDATE_TRIGGER to webhook)
 *   → POST /v1/flows/:id (ADD_ACTION code step)
 *   → POST /v1/flows/:id (LOCK_AND_PUBLISH)
 *   → POST /api/v1/webhooks/:flowId/sync (fire webhook, poll run to SUCCEEDED)
 *
 * Also tests the draft variant:
 *   Same setup without publish
 *   → POST /api/v1/webhooks/:flowId/draft/sync (execute against draft version)
 *
 * Prerequisites:
 *   - Engine must be built (cache/v7/common/main.js)
 *   - bun must be available for piece installation
 *   - Redis (in-memory via AP_REDIS_TYPE=MEMORY) is started automatically
 */
import { FlowActionType, FlowOperationType, FlowRunStatus, FlowVersionState, PackageType, PopulatedFlow, QadamType } from '@aiqadam/shared'
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
                type: 'PIECE',
                settings: {
                    qadamName: '@aiqadam/qadam-webhook',
                    qadamVersion: '0.1.29',
                    input: { authType: 'none' },
                    triggerName: 'catch_webhook',
                    propertySettings: {},
                },
                valid: false,
                name: 'trigger',
                displayName: 'Catch Webhook',
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
                        input: {},
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
            url: `/api/v1/webhooks/${flow.id}/sync`,
            payload: { message: 'hello world' },
        })

        expect(webhookResponse.statusCode).toBe(StatusCodes.OK)

        // Step 6: Find the resulting flow run and verify it completed successfully
        const webhookRunId = webhookResponse.headers['x-webhook-id'] as string
        expect(webhookRunId).toBeDefined()

        const runsResponse = await ctx.get('/v1/flow-runs', {
            projectId: ctx.project.id,
            flowId: flow.id,
        })
        expect(runsResponse.statusCode).toBe(StatusCodes.OK)

        const runs: Array<{ id: string }> = runsResponse.json().data
        expect(runs.length).toBeGreaterThan(0)

        const flowRunId = runs[0].id
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })

        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
        expect(result.steps.step_1.output).toEqual(
            expect.objectContaining({
                success: true,
                message: 'hello world',
            }),
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
                type: 'PIECE',
                settings: {
                    qadamName: '@aiqadam/qadam-webhook',
                    qadamVersion: '0.1.29',
                    input: { authType: 'none' },
                    triggerName: 'catch_webhook',
                    propertySettings: {},
                },
                valid: false,
                name: 'trigger',
                displayName: 'Catch Webhook',
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
                        input: {},
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

        // Step 4: Fire the draft sync webhook — no publish required
        const webhookResponse = await app.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flow.id}/draft/sync`,
            payload: { message: 'draft test' },
        })

        expect(webhookResponse.statusCode).toBe(StatusCodes.OK)

        // Step 5: Verify the draft run completed successfully
        const runsResponse = await ctx.get('/v1/flow-runs', {
            projectId: ctx.project.id,
            flowId: flow.id,
        })
        expect(runsResponse.statusCode).toBe(StatusCodes.OK)

        const runs: Array<{ id: string }> = runsResponse.json().data
        expect(runs.length).toBeGreaterThan(0)

        const flowRunId = runs[0].id
        const result = await pollFlowRunToCompletion({ flowRunId, projectId: ctx.project.id })

        expect(result.status).toBe(FlowRunStatus.SUCCEEDED)
        expect(result.steps.step_1.output).toEqual(
            expect.objectContaining({
                success: true,
                message: 'draft test',
            }),
        )
    }, 120_000)
})
