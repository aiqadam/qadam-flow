import { apId, FlowOperationType, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Request validation', () => {
    describe('runs after the principal is admitted', () => {
        it('rejects an anonymous request before validating its body', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/records/batch',
                body: oversizedInvalidBatch(),
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response.body.length).toBeLessThan(1024)
        })

        it('rejects an invalid bearer token before validating the body', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/records/batch',
                headers: { authorization: 'Bearer not-a-token' },
                body: oversizedInvalidBatch(),
            })

            expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
            expect(response.body.length).toBeLessThan(1024)
        })

        it('rejects a principal type the route does not allow before validating the body', async () => {
            const workerToken = await generateMockToken({ type: PrincipalType.WORKER, id: apId() })

            const response = await app!.inject({
                method: 'POST',
                url: '/api/v1/records/batch',
                headers: { authorization: `Bearer ${workerToken}` },
                body: oversizedInvalidBatch(),
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(response.body.length).toBeLessThan(1024)
        })

        it('does not run the flow import migration for an anonymous request', async () => {
            const ctx = await createTestContext(app!)
            const flow = createMockFlow({ projectId: ctx.project.id })
            await db.save('flow', flow)
            await db.save('flow_version', createMockFlowVersion({ flowId: flow.id }))

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/flows/${flow.id}`,
                body: {
                    type: FlowOperationType.IMPORT_FLOW,
                    request: {
                        displayName: 'x',
                        schemaVersion: '1',
                        trigger: 'not a trigger',
                    },
                },
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('still validates the body of an admitted principal', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records/batch', { tableId: apId() })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })

    describe('bounds the rejection it returns', () => {
        it('caps the issues listed in the message', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records/batch', {
                tableId: apId(),
                records: [{ id: apId(), cells: Array(1000).fill(1) }],
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            const body = response?.json()
            expect(body.message).toContain('990 more')
            expect(response?.body.length).toBeLessThan(4096)
        })

        it('answers 400, not 500, when the schema itself throws', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records/batch', oversizedInvalidBatch())

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.body.length).toBeLessThan(4096)
        })

        it('answers 400, not 500, when a public route schema throws', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/register',
                body: { redirect_uris: ['not a url'] },
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })
})

// Large enough that zod's issue aggregation overflows the stack when one nested
// array element carries this many issues.
function oversizedInvalidBatch(): Record<string, unknown> {
    return {
        tableId: apId(),
        records: [{ id: apId(), cells: Array(200_000).fill(1) }],
    }
}
