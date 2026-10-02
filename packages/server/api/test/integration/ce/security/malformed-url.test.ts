import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// GHSA-p68q-wchp-6fh7: before fastify 5.12.2, a malformed request target whose method had no
// route in the main router was dispatched straight to the last-registered not-found handler,
// skipping the request lifecycle (onRequest/preValidation/preHandler hooks, so authentication
// too). These tests pin that such a request now fails closed with the router's 400 instead of
// reaching `setNotFoundHandler` in server.ts.
const MALFORMED_SEGMENT = '%E0%A4%A'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Malformed request URL', () => {
    it('answers 400 for a method no route is registered for, instead of running the not-found handler', async () => {
        const response = await app.inject({
            method: 'PATCH',
            url: `/api/v1/flows/${MALFORMED_SEGMENT}`,
        })

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(response.json()).toMatchObject({ code: 'FST_ERR_BAD_URL' })
    })

    it('answers 400 outside the /api prefix too, instead of serving the SPA fallback', async () => {
        const response = await app.inject({
            method: 'PATCH',
            url: `/flows/${MALFORMED_SEGMENT}`,
        })

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(response.json()).toMatchObject({ code: 'FST_ERR_BAD_URL' })
    })

    it('answers 400 on an authenticated route without reaching its handler', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/api/v1/flows/${MALFORMED_SEGMENT}`,
        })

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(response.json()).toMatchObject({ code: 'FST_ERR_BAD_URL' })
    })
})
