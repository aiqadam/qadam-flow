import { apId, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Translation Worker API', () => {
    it('returns only the translations belonging to the engine principal\'s own project', async () => {
        const { mockProject: projectA, mockPlatform: platformA, mockOwner: ownerA } = await mockAndSaveBasicSetup()
        const tokenA = await generateMockToken({ id: ownerA.id, type: PrincipalType.USER, platform: { id: platformA.id } })
        const createInA = await app?.inject({
            method: 'POST',
            url: '/api/v1/translations',
            headers: { authorization: `Bearer ${tokenA}` },
            payload: { projectId: projectA.id, translations: [{ key: 'project.a.only', values: { en: 'A only' } }] },
        })
        expect(createInA?.statusCode).toBe(StatusCodes.OK)

        const { mockProject: projectB, mockPlatform: platformB, mockOwner: ownerB } = await mockAndSaveBasicSetup()
        const tokenB = await generateMockToken({ id: ownerB.id, type: PrincipalType.USER, platform: { id: platformB.id } })
        const createInB = await app?.inject({
            method: 'POST',
            url: '/api/v1/translations',
            headers: { authorization: `Bearer ${tokenB}` },
            payload: { projectId: projectB.id, translations: [{ key: 'project.b.only', values: { en: 'B only' } }] },
        })
        expect(createInB?.statusCode).toBe(StatusCodes.OK)

        // The map shape (`{ translations: [...] }`) bypasses `entitiesMustBeOwnedByCurrentProject` —
        // the isolation this proves comes entirely from `translationService.listForWorker` filtering
        // by the engine principal's own `projectId`, never from that hook.
        const engineTokenForB = await generateMockToken({
            type: PrincipalType.ENGINE,
            id: apId(),
            platform: { id: platformB.id },
            projectId: projectB.id,
        })

        const response = await app?.inject({
            method: 'GET',
            url: '/api/v1/worker/translations',
            headers: {
                authorization: `Bearer ${engineTokenForB}`,
            },
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        const keys = response?.json().translations.map((t: { key: string }) => t.key)
        expect(keys).toContain('project.b.only')
        expect(keys).not.toContain('project.a.only')
    })

    it('rejects a request with no authorization', async () => {
        const response = await app?.inject({
            method: 'GET',
            url: '/api/v1/worker/translations',
        })
        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
    })
})
