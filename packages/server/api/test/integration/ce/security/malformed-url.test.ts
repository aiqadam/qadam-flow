import http from 'node:http'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// GHSA-p68q-wchp-6fh7 (fixed in fastify 5.12.2): a malformed URL whose method has no tree in the
// main router used to be handed to the root not-found handler outside the normal request
// lifecycle. Every method fastify supports has a tree here, because `app.all(...)` (webhooks,
// waitpoint resume, app events) registers all of them, so only a method fastify does not support
// at all, such as PROPFIND, reaches that path. The PROPFIND cases are the regression tests: they
// fail on 5.8.5 and pass on 5.12.5. They go over a real socket because `app.inject` only accepts
// methods fastify supports. The PATCH and GET cases pin the 400 the main router already returned
// for methods that have a tree.
const MALFORMED_SEGMENT = '%E0%A4%A'
const METHOD_WITHOUT_ROUTE_TREE = 'PROPFIND'
const SOCKET_TIMEOUT_MS = 5000

let app: FastifyInstance
let port: number

beforeAll(async () => {
    app = await setupTestEnvironment()
    if (!app.server.listening) {
        await app.listen({ port: 0, host: '127.0.0.1' })
    }
    port = listeningPort(app)
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Malformed request URL', () => {
    describe('for a method with no route tree', () => {
        it('answers 400 under /api instead of running the not-found handler', async () => {
            const response = await sendOverSocket({ method: METHOD_WITHOUT_ROUTE_TREE, path: `/api/v1/flows/${MALFORMED_SEGMENT}` })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(JSON.parse(response.body)).toMatchObject({ code: 'FST_ERR_BAD_URL' })
        })

        it('answers 400 on an SPA route instead of running the not-found handler', async () => {
            const response = await sendOverSocket({ method: METHOD_WITHOUT_ROUTE_TREE, path: `/flows/${MALFORMED_SEGMENT}` })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(JSON.parse(response.body)).toMatchObject({ code: 'FST_ERR_BAD_URL' })
        })
    })

    describe('for a method with a route tree (pins existing behaviour)', () => {
        it('answers 400 for PATCH, which only app.all routes register', async () => {
            const response = await app.inject({
                method: 'PATCH',
                url: `/api/v1/flows/${MALFORMED_SEGMENT}`,
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response.json()).toMatchObject({ code: 'FST_ERR_BAD_URL' })
        })

        it('answers 400 for GET on an API path', async () => {
            const response = await app.inject({
                method: 'GET',
                url: `/api/v1/flows/${MALFORMED_SEGMENT}`,
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
            expect(response.json()).toMatchObject({ code: 'FST_ERR_BAD_URL' })
        })
    })
})

function listeningPort(instance: FastifyInstance): number {
    const address = instance.server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('test server is not listening on a TCP port')
    }
    return address.port
}

function sendOverSocket({ method, path }: { method: string, path: string }): Promise<SocketResponse> {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path, timeout: SOCKET_TIMEOUT_MS }, (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            response.on('error', reject)
        })
        request.on('timeout', () => request.destroy(new Error(`${method} ${path} got no response within ${SOCKET_TIMEOUT_MS} ms`)))
        request.on('error', reject)
        request.end()
    })
}

type SocketResponse = {
    statusCode: number
    body: string
}
