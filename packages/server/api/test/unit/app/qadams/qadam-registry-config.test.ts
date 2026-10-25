import { createServer, IncomingMessage, Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamRegistryConfig } from '../../../../src/app/qadams/version-store/qadam-registry-config'

const URL_ENV = `AP_${AppSystemProp.QADAM_REGISTRY_URL}`
const TOKEN_ENV = `AP_${AppSystemProp.QADAM_REGISTRY_TOKEN}`

describe('qadamRegistryConfig.get', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('defaults to npmjs with no token', () => {
        vi.stubEnv(URL_ENV, undefined)
        vi.stubEnv(TOKEN_ENV, undefined)

        expect(qadamRegistryConfig.get()).toEqual({ url: 'https://registry.npmjs.org', token: null })
    })

    it('reads a configured registry and token', () => {
        vi.stubEnv(URL_ENV, 'https://npm.example.internal')
        vi.stubEnv(TOKEN_ENV, 'super-secret-token')

        expect(qadamRegistryConfig.get()).toEqual({ url: 'https://npm.example.internal', token: 'super-secret-token' })
    })
})

describe('qadamRegistryConfig.isDefault', () => {
    it('matches the default URL regardless of case or a trailing slash', () => {
        expect(qadamRegistryConfig.isDefault({ url: 'https://registry.npmjs.org' })).toBe(true)
        expect(qadamRegistryConfig.isDefault({ url: 'HTTPS://REGISTRY.NPMJS.ORG/' })).toBe(true)
    })

    it('does not match a different registry', () => {
        expect(qadamRegistryConfig.isDefault({ url: 'https://npm.example.internal' })).toBe(false)
    })
})

describe('qadamRegistryConfig.checkReachability', () => {
    let server: Server
    let baseUrl: string
    let lastRequest: IncomingMessage | null
    let statusToAnswer: number

    beforeAll(async () => {
        server = createServer((request, response) => {
            lastRequest = request
            response.writeHead(statusToAnswer).end()
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (typeof address !== 'object' || address === null) {
            throw new Error('the fixture server has no port')
        }
        baseUrl = `http://127.0.0.1:${address.port}/`
    })

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    beforeEach(() => {
        lastRequest = null
        statusToAnswer = 200
        // The default SSRF allow list refuses loopback; these tests point at a local fixture server
        // on purpose, the same way qadam-version-catalogue.test.ts does for its own HTTP source.
        vi.stubEnv('AP_SSRF_ALLOW_LIST', '127.0.0.1')
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('is reachable when the registry answers at all', async () => {
        const result = await qadamRegistryConfig.checkReachability({ url: baseUrl, token: null })

        expect(result).toEqual({ reachable: true })
        expect(lastRequest?.url).toBe('/-/ping')
    })

    it('is reachable even on a 404 or 401: the host answered', async () => {
        statusToAnswer = 404
        expect(await qadamRegistryConfig.checkReachability({ url: baseUrl, token: null })).toEqual({ reachable: true })

        statusToAnswer = 401
        expect(await qadamRegistryConfig.checkReachability({ url: baseUrl, token: 'a-token' })).toEqual({ reachable: true })
    })

    it('sends the token as a bearer header, and sends nothing when there is none', async () => {
        await qadamRegistryConfig.checkReachability({ url: baseUrl, token: 'super-secret-token' })
        expect(lastRequest?.headers.authorization).toBe('Bearer super-secret-token')

        await qadamRegistryConfig.checkReachability({ url: baseUrl, token: null })
        expect(lastRequest?.headers.authorization).toBeUndefined()
    })

    it('is unreachable for a connection that is refused, and never throws', async () => {
        const unreachableUrl = 'http://127.0.0.1:1/'

        const result = await qadamRegistryConfig.checkReachability({ url: unreachableUrl, token: 'super-secret-token' })

        expect(result.reachable).toBe(false)
        expect(result.reachable === false && result.reason).not.toContain('super-secret-token')
    })

    it('is unreachable, not thrown, when the SSRF filter refuses an unconfigured loopback target', async () => {
        vi.stubEnv('AP_SSRF_ALLOW_LIST', undefined)

        const result = await qadamRegistryConfig.checkReachability({ url: baseUrl, token: null })

        expect(result.reachable).toBe(false)
    })
})
