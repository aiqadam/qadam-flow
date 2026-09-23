import { FlowStatus, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import * as flowRunServiceModule from '../../../../src/app/flows/flow-run/flow-run-service'
import * as webhookBackpressureServiceModule from '../../../../src/app/webhooks/webhook-backpressure-service'
import * as engineResponseWatcherModule from '../../../../src/app/workers/engine-response-watcher'
import { createHandlers } from '../../../../src/app/workers/rpc/worker-rpc-service'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

const { engineResponseWatcher } = engineResponseWatcherModule

let app: FastifyInstance | null = null
const MOCK_FLOW_ID = '8hfKOpm3kY1yAi1ApYOa1'
beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})
describe('Webhook Service', () => {
    it('should accept webhook for enabled flow', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should return GONE if the flow is not found', async () => {
        const { mockOwner, mockPlatform } = await mockAndSaveBasicSetup()
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            id: mockOwner.id,
            platform: {
                id: mockPlatform.id,
            },
        })

        const response = await app?.inject({
            method: 'GET',
            url: `/api/v1/webhooks/${MOCK_FLOW_ID}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.GONE)
    })
    it('should return NOT FOUND if the flow is disabled', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.DISABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'GET',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('should pass query parameters in webhook payload', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}?foo=bar&baz=qux`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should accept GET method', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'GET',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should accept PUT method', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'PUT',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should accept DELETE method', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'DELETE',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should return x-webhook-id header in response', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(response?.headers['x-webhook-id']).toBeDefined()
    })

    it('should accept webhook on draft endpoint', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.DISABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}/draft`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should return 413 when webhook payload exceeds MAX_WEBHOOK_PAYLOAD_SIZE_MB', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        // Generate payload larger than 25MB (default limit)
        const largePayload = { data: 'x'.repeat(26 * 1024 * 1024) }
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: largePayload,
        })
        expect(response?.statusCode).toBe(StatusCodes.REQUEST_TOO_LONG)
    })

    it('should accept webhook payload under MAX_WEBHOOK_PAYLOAD_SIZE_MB', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('should return 413 for sync webhook when payload exceeds limit', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const largePayload = { data: 'x'.repeat(26 * 1024 * 1024) }
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}/sync`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: largePayload,
        })
        expect(response?.statusCode).toBe(StatusCodes.REQUEST_TOO_LONG)
    })

    it('should accept webhook on test endpoint without execution', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.DISABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${mockFlow.id}/test`,
            headers: {
                authorization: `Bearer ${mockToken}`,
            },
            body: { test: true },
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
    })

    it('registers the sync listener before starting the run, so an immediate engine response is not dropped', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })

        const listenOrder = vi.fn()
        const startOrder = vi.fn()
        // start()'s httpRequestId (webhookRequestId) is minted internally and only surfaced on
        // the response headers once the run finishes — capture it off the start() call instead,
        // the same way the resume ordering test reads its id off the queued job. Spying on
        // addToQueue itself would not work here: flowRunService.start() calls addToQueue from
        // within the same source file, so it never goes through the exported binding this spy
        // replaces — only a cross-module call site (webhook.service.ts importing flowRunService)
        // is actually interceptable this way.
        let capturedHttpRequestId: string | undefined

        const originalFlowRunService = flowRunServiceModule.flowRunService
        const flowRunServiceSpy = vi.spyOn(flowRunServiceModule, 'flowRunService')
            .mockImplementation((log): ReturnType<typeof flowRunServiceModule.flowRunService> => {
                const real = originalFlowRunService(log)
                return {
                    ...real,
                    async start(params: Parameters<typeof real.start>[0]) {
                        startOrder()
                        capturedHttpRequestId = params.httpRequestId
                        return real.start(params)
                    },
                }
            })

        const originalEngineResponseWatcher = engineResponseWatcherModule.engineResponseWatcher
        const watcherSpy = vi.spyOn(engineResponseWatcherModule, 'engineResponseWatcher')
            .mockImplementation((log): ReturnType<typeof engineResponseWatcherModule.engineResponseWatcher> => {
                const real = originalEngineResponseWatcher(log)
                return {
                    ...real,
                    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T) {
                        listenOrder()
                        return real.oneTimeListener<T>(requestId, timeoutRequest, timeoutMs, defaultResponse)
                    },
                }
            })

        try {
            const responsePromise = app?.inject({
                method: 'POST',
                url: `/api/v1/webhooks/${mockFlow.id}/sync`,
                headers: {
                    authorization: `Bearer ${mockToken}`,
                },
                body: { test: true },
            })

            const start = Date.now()
            while (capturedHttpRequestId === undefined && Date.now() - start < 5000) {
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
            if (capturedHttpRequestId === undefined) {
                throw new Error('Timed out waiting for the webhook run to be queued')
            }

            const workerHandlerId = engineResponseWatcher(app!.log).getServerId()
            await createHandlers(app!.log).sendFlowResponse({
                workerHandlerId,
                httpRequestId: capturedHttpRequestId,
                runResponse: { status: 200, body: { ok: true }, headers: {} },
            })

            const response = await responsePromise
            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(response?.json()).toEqual({ ok: true })

            expect(listenOrder).toHaveBeenCalledTimes(1)
            expect(startOrder).toHaveBeenCalledTimes(1)
            // The listener must be registered before the run is started — otherwise an engine
            // response published the instant the run is queued reaches no one (same class of
            // bug as #519's resume paths).
            expect(listenOrder.mock.invocationCallOrder[0]).toBeLessThan(startOrder.mock.invocationCallOrder[0])
        }
        finally {
            flowRunServiceSpy.mockRestore()
            watcherSpy.mockRestore()
        }
    })

    it('refuses a sync webhook with 503 and a Retry-After header when the instance is saturated (#510)', async () => {
        const { mockProject, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
        const mockFlow = createMockFlow({
            projectId: mockProject.id,
            status: FlowStatus.ENABLED,
        })
        await db.save('flow', [mockFlow])
        const mockFlowVersion = createMockFlowVersion({
            flowId: mockFlow.id,
        })
        await db.save('flow_version', [mockFlowVersion])
        await db.update('flow', mockFlow.id, {
            publishedVersionId: mockFlowVersion.id,
        })
        const mockToken = await generateMockToken({
            type: PrincipalType.USER,
            platform: {
                id: mockPlatform.id,
            },
            id: mockOwner.id,
        })

        // Real saturation needs 40+ concurrent callers against a live worker registry — impractical
        // in this suite. Stubbing checkCapacity() directly exercises the same contract handleSync
        // relies on without needing a real worker or a real backlog.
        const backpressureSpy = vi.spyOn(webhookBackpressureServiceModule, 'webhookBackpressureService')
            .mockReturnValue({
                checkCapacity: vi.fn().mockResolvedValue({ ok: false, retryAfterSeconds: 7 }),
            })

        try {
            const response = await app?.inject({
                method: 'POST',
                url: `/api/v1/webhooks/${mockFlow.id}/sync`,
                headers: {
                    authorization: `Bearer ${mockToken}`,
                },
                body: { test: true },
            })

            expect(response?.statusCode).toBe(StatusCodes.SERVICE_UNAVAILABLE)
            expect(response?.headers['retry-after']).toBe('7')
        }
        finally {
            backpressureSpy.mockRestore()
        }
    })
})
