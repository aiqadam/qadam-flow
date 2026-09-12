import { apId } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { longPollingServed } from '../../../../src/app/trigger/long-polling/long-polling-served'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(() => {
    longPollingServed.clear()
})

/**
 * In pull mode the qadam has told the third party to stop calling the webhook URL, so anything
 * arriving there is not from the third party — the endpoint is public and the flow id is its only
 * secret. The guard runs before any flow lookup, which is why these cases need no flow: a served
 * id is refused and an unserved one falls through to the normal not-found path.
 */
describe('Webhook endpoints while a flow is served by long polling', () => {
    it.each(['', '/sync'])('refuses the production route %s', async (suffix) => {
        const flowId = apId()
        longPollingServed.replaceAll([flowId])

        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flowId}${suffix}`,
            payload: { hello: 'world' },
        })

        expect(response?.statusCode).toBe(StatusCodes.CONFLICT)
    })

    // The builder's test panel must keep working: it is how a user checks a trigger, and it does
    // not go through the third party at all.
    it.each(['/draft', '/draft/sync', '/test'])('leaves the builder route %s alone', async (suffix) => {
        const flowId = apId()
        longPollingServed.replaceAll([flowId])

        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${flowId}${suffix}`,
            payload: { hello: 'world' },
        })

        expect(response?.statusCode).not.toBe(StatusCodes.CONFLICT)
    })

    it('does not refuse a flow that is not served by pulling', async () => {
        const response = await app?.inject({
            method: 'POST',
            url: `/api/v1/webhooks/${apId()}`,
            payload: { hello: 'world' },
        })

        expect(response?.statusCode).not.toBe(StatusCodes.CONFLICT)
    })
})
