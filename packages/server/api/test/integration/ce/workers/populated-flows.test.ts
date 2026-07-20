import { apId, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('GET /v1/engine/populated-flows', () => {
    it('returns all flows when multiple externalIds are passed as repeated query params', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()

        const externalIdA = apId()
        const externalIdB = apId()
        const externalIdC = apId()

        const flowA = createMockFlow({ projectId: mockProject.id, externalId: externalIdA })
        const flowB = createMockFlow({ projectId: mockProject.id, externalId: externalIdB })
        const flowC = createMockFlow({ projectId: mockProject.id, externalId: externalIdC })

        await db.save('flow', [flowA, flowB, flowC])
        await db.save('flow_version', [
            createMockFlowVersion({ flowId: flowA.id }),
            createMockFlowVersion({ flowId: flowB.id }),
            createMockFlowVersion({ flowId: flowC.id }),
        ])

        const engineToken = await generateMockToken({
            type: PrincipalType.ENGINE,
            id: apId(),
            projectId: mockProject.id,
            platform: { id: mockPlatform.id },
        })

        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/engine/populated-flows',
            // Repeated params — the correct encoding that URLSearchParams.append() produces
            query: `externalIds=${externalIdA}&externalIds=${externalIdB}&externalIds=${externalIdC}`,
            headers: { authorization: `Bearer ${engineToken}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)

        const body = response.json()
        const returnedExternalIds = body.data.map((f: { externalId: string }) => f.externalId)

        expect(returnedExternalIds).toContain(externalIdA)
        expect(returnedExternalIds).toContain(externalIdB)
        expect(returnedExternalIds).toContain(externalIdC)
    })

    it('returns only the requested flows when filtering by externalIds', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()

        const externalIdA = apId()
        const externalIdB = apId()
        const externalIdOther = apId()

        const flowA = createMockFlow({ projectId: mockProject.id, externalId: externalIdA })
        const flowB = createMockFlow({ projectId: mockProject.id, externalId: externalIdB })
        const flowOther = createMockFlow({ projectId: mockProject.id, externalId: externalIdOther })

        await db.save('flow', [flowA, flowB, flowOther])
        await db.save('flow_version', [
            createMockFlowVersion({ flowId: flowA.id }),
            createMockFlowVersion({ flowId: flowB.id }),
            createMockFlowVersion({ flowId: flowOther.id }),
        ])

        const engineToken = await generateMockToken({
            type: PrincipalType.ENGINE,
            id: apId(),
            projectId: mockProject.id,
            platform: { id: mockPlatform.id },
        })

        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/engine/populated-flows',
            query: `externalIds=${externalIdA}&externalIds=${externalIdB}`,
            headers: { authorization: `Bearer ${engineToken}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)

        const body = response.json()
        const returnedExternalIds = body.data.map((f: { externalId: string }) => f.externalId)

        expect(returnedExternalIds).toContain(externalIdA)
        expect(returnedExternalIds).toContain(externalIdB)
        expect(returnedExternalIds).not.toContain(externalIdOther)
    })

    it('returns zero flows when externalIds are passed as a single comma-joined string (regression: old broken format)', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()

        const externalIdA = apId()
        const externalIdB = apId()

        const flowA = createMockFlow({ projectId: mockProject.id, externalId: externalIdA })
        const flowB = createMockFlow({ projectId: mockProject.id, externalId: externalIdB })

        await db.save('flow', [flowA, flowB])
        await db.save('flow_version', [
            createMockFlowVersion({ flowId: flowA.id }),
            createMockFlowVersion({ flowId: flowB.id }),
        ])

        const engineToken = await generateMockToken({
            type: PrincipalType.ENGINE,
            id: apId(),
            projectId: mockProject.id,
            platform: { id: mockPlatform.id },
        })

        // Simulate the old broken encoding: externalIds=idA,idB as a single value
        const response = await app!.inject({
            method: 'GET',
            url: '/api/v1/engine/populated-flows',
            query: `externalIds=${externalIdA},${externalIdB}`,
            headers: { authorization: `Bearer ${engineToken}` },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)

        const body = response.json()
        // The comma-joined string matches no externalId, so the result must be empty
        expect(body.data).toHaveLength(0)
    })
})
