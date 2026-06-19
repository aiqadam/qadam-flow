import {
    apId,
    AppConnectionType,
    FlowRunStatus,
    FlowStatus,
    FlowVersionState,
    PackageType,
    QadamType,
    RunEnvironment,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { qadamMetadataService } from '../../../src/app/qadams/metadata/qadam-metadata-service'
import { db } from '../../helpers/db'
import {
    createMockFlow,
    createMockFlowRun,
    createMockFlowVersion,
    createMockQadamMetadata,
    createMockTable,
} from '../../helpers/mocks'
import { createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Cross-project tenant isolation', () => {

    describe('Flows', () => {
        it('Project A creates flow — Project B cannot list it', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const mockFlow = createMockFlow({
                projectId: ctxA.project.id,
                status: FlowStatus.ENABLED,
            })
            await db.save('flow', mockFlow)

            const mockFlowVersion = createMockFlowVersion({
                flowId: mockFlow.id,
                state: FlowVersionState.LOCKED,
            })
            await db.save('flow_version', mockFlowVersion)

            const response = await ctxB.get('/v1/flows', {
                projectId: ctxB.project.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            const flowIds = (body.data ?? []).map((f: { id: string }) => f.id)
            expect(flowIds).not.toContain(mockFlow.id)
        })

        it('Project A creates flow — Project B cannot get it by ID', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const mockFlow = createMockFlow({
                projectId: ctxA.project.id,
                status: FlowStatus.ENABLED,
            })
            await db.save('flow', mockFlow)

            const mockFlowVersion = createMockFlowVersion({
                flowId: mockFlow.id,
                state: FlowVersionState.LOCKED,
            })
            await db.save('flow_version', mockFlowVersion)

            const response = await ctxB.get(`/v1/flows/${mockFlow.id}`)

            expect([StatusCodes.FORBIDDEN, StatusCodes.NOT_FOUND]).toContain(response?.statusCode)
        })
    })

    describe('Flow Runs', () => {
        it('Project A flow runs are not visible to Project B', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const mockFlow = createMockFlow({
                projectId: ctxA.project.id,
                status: FlowStatus.ENABLED,
            })
            await db.save('flow', mockFlow)

            const mockFlowVersion = createMockFlowVersion({
                flowId: mockFlow.id,
                state: FlowVersionState.LOCKED,
            })
            await db.save('flow_version', mockFlowVersion)

            const mockFlowRun = createMockFlowRun({
                projectId: ctxA.project.id,
                flowId: mockFlow.id,
                flowVersionId: mockFlowVersion.id,
                status: FlowRunStatus.SUCCEEDED,
                environment: RunEnvironment.PRODUCTION,
            })
            await db.save('flow_run', mockFlowRun)

            const response = await ctxB.get('/v1/flow-runs', {
                projectId: ctxB.project.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            const runIds = (body.data ?? []).map((r: { id: string }) => r.id)
            expect(runIds).not.toContain(mockFlowRun.id)
        })
    })

    describe('App Connections', () => {
        it('Project A creates connection — Project B cannot list it', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const mockPiece = createMockQadamMetadata({
                name: `@aiqadam/qadam-isolation-list-${apId()}`,
                version: '0.1.0',
                platformId: ctxA.platform.id,
                packageType: PackageType.REGISTRY,
                qadamType: QadamType.OFFICIAL,
            })
            await db.save('qadam_metadata', mockPiece)
            qadamMetadataService(mockLog).getOrThrow = vi.fn().mockResolvedValue(mockPiece)

            const externalId = `isolation-list-${apId()}`
            const createResponse = await ctxA.post('/v1/app-connections', {
                externalId,
                displayName: 'Project A Connection',
                qadamName: mockPiece.name,
                projectId: ctxA.project.id,
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'test-secret',
                },
                qadamVersion: mockPiece.version,
            })
            expect(createResponse?.statusCode).toBe(StatusCodes.CREATED)

            const response = await ctxB.get('/v1/app-connections', {
                projectId: ctxB.project.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            const externalIds = (body.data ?? []).map((c: { externalId: string }) => c.externalId)
            expect(externalIds).not.toContain(externalId)
        })

        it('Project A creates connection — Project B cannot get it by ID', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const mockPiece = createMockQadamMetadata({
                name: `@aiqadam/qadam-isolation-get-${apId()}`,
                version: '0.1.0',
                platformId: ctxA.platform.id,
                packageType: PackageType.REGISTRY,
                qadamType: QadamType.OFFICIAL,
            })
            await db.save('qadam_metadata', mockPiece)
            qadamMetadataService(mockLog).getOrThrow = vi.fn().mockResolvedValue(mockPiece)

            const createResponse = await ctxA.post('/v1/app-connections', {
                externalId: `isolation-get-${apId()}`,
                displayName: 'Project A Connection',
                qadamName: mockPiece.name,
                projectId: ctxA.project.id,
                type: AppConnectionType.SECRET_TEXT,
                value: {
                    type: AppConnectionType.SECRET_TEXT,
                    secret_text: 'test-secret',
                },
                qadamVersion: mockPiece.version,
            })
            expect(createResponse?.statusCode).toBe(StatusCodes.CREATED)
            const connectionId = createResponse?.json().id

            const response = await ctxB.get(`/v1/app-connections/${connectionId}`)

            expect([StatusCodes.FORBIDDEN, StatusCodes.NOT_FOUND]).toContain(response?.statusCode)
        })
    })

    describe('Tables', () => {
        it('Project A creates table — Project B cannot list it', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const table = createMockTable({ projectId: ctxA.project.id })
            await db.save('table', table)

            const response = await ctxB.get('/v1/tables', {
                projectId: ctxB.project.id,
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            const tableIds = (body.data ?? []).map((t: { id: string }) => t.id)
            expect(tableIds).not.toContain(table.id)
        })

        it('Project A creates table — Project B cannot get it by ID', async () => {
            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const table = createMockTable({ projectId: ctxA.project.id })
            await db.save('table', table)

            const response = await ctxB.get(`/v1/tables/${table.id}`)

            expect([StatusCodes.FORBIDDEN, StatusCodes.NOT_FOUND]).toContain(response?.statusCode)
        })
    })
})
