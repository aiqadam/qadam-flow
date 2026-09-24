import { apId, FlowOperationType, MAX_CELLS_PER_RECORD, MAX_RECORDS_PER_CREATE, PrincipalType } from '@aiqadam/shared'
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

    describe('bounds the work a body can cause', () => {
        it('reports only the first invalid cell of a batch', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records/batch', {
                tableId: apId(),
                records: [{ id: apId(), cells: Array(MAX_CELLS_PER_RECORD).fill(1) }],
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.json().message).toBe('body/records/0/cells/0 Invalid input: expected object, received number')
        })

        it('rejects a row wider than the cap with one issue', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records/batch', oversizedInvalidBatch())

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.json().message).toContain('body/records/0/cells')
            expect(response?.body.length).toBeLessThan(1024)
        })

        it('rejects a create over the record cap with one issue', async () => {
            const ctx = await createTestContext(app!)

            const response = await ctx.post('/v1/records', {
                tableId: apId(),
                records: Array(MAX_RECORDS_PER_CREATE + 1).fill([]),
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response?.body.length).toBeLessThan(1024)
        })

        it('answers 400, not 500, for a malformed redirect URI on the public register route', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/register',
                body: { redirect_uris: ['not a url'] },
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('caps the redirect URIs the public register route accepts', async () => {
            const response = await app!.inject({
                method: 'POST',
                url: '/register',
                body: { redirect_uris: Array(21).fill('https://example.com/callback') },
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })
})

// Before the cells array was bounded, this many invalid cells in one nested row made zod
// overflow the stack while aggregating their issues.
function oversizedInvalidBatch(): Record<string, unknown> {
    return {
        tableId: apId(),
        records: [{ id: apId(), cells: Array(200_000).fill(1) }],
    }
}
