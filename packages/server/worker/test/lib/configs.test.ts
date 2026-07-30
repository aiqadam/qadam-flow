import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getApiUrl, getSocketUrl, system } from '../../src/lib/config/configs'

const savedContainerType = process.env.AP_CONTAINER_TYPE
const savedFrontendUrl = process.env.AP_FRONTEND_URL
const savedWorkerApiUrl = process.env.AP_WORKER_API_URL

function cleanEnv() {
    delete process.env.AP_CONTAINER_TYPE
    delete process.env.AP_FRONTEND_URL
    delete process.env.AP_WORKER_API_URL
}

function restoreEnv() {
    if (savedContainerType !== undefined) process.env.AP_CONTAINER_TYPE = savedContainerType
    else delete process.env.AP_CONTAINER_TYPE
    if (savedFrontendUrl !== undefined) process.env.AP_FRONTEND_URL = savedFrontendUrl
    else delete process.env.AP_FRONTEND_URL
    if (savedWorkerApiUrl !== undefined) process.env.AP_WORKER_API_URL = savedWorkerApiUrl
    else delete process.env.AP_WORKER_API_URL
}

describe('getApiUrl', () => {
    beforeEach(cleanEnv)
    afterEach(restoreEnv)

    // The pre-#211 implementation returned http://127.0.0.1:${PORT}/api/ whenever the container
    // type was WORKER_AND_APP *or unset*. Leaving it unset is what makes this case detect the
    // branch rather than merely avoid it: on the old code it returned loopback, so the assertion
    // below fails there and passes here. Without it the branch could be reinstated and the suite
    // would stay green.
    it('ignores the container type entirely — an unset one no longer means loopback', () => {
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org'
        expect(getApiUrl()).toBe('https://flow.aiqadam.org/api/')
        expect(getSocketUrl()).toEqual({ url: 'https://flow.aiqadam.org', path: '/api/socket.io' })
    })

    it('resolves the same URL for APP as for WORKER', () => {
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org'
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        const asWorker = getApiUrl()
        process.env.AP_CONTAINER_TYPE = 'APP'
        expect(getApiUrl()).toBe(asWorker)
        expect(asWorker).toBe('https://flow.aiqadam.org/api/')
    })

    it('prefers WORKER_API_URL over FRONTEND_URL', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        process.env.AP_WORKER_API_URL = 'http://app:80/'
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org'
        expect(getApiUrl()).toBe('http://app:80/api/')
    })

    it('returns FRONTEND_URL/api/ when CONTAINER_TYPE is WORKER (with trailing slash)', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org/'
        expect(getApiUrl()).toBe('https://flow.aiqadam.org/api/')
    })

    it('returns FRONTEND_URL/api/ when CONTAINER_TYPE is WORKER (without trailing slash)', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org'
        expect(getApiUrl()).toBe('https://flow.aiqadam.org/api/')
    })
})

describe('getSocketUrl', () => {
    beforeEach(cleanEnv)
    afterEach(restoreEnv)

    it('resolves the same socket for APP as for WORKER', () => {
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org'
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        const asWorker = getSocketUrl()
        process.env.AP_CONTAINER_TYPE = 'APP'
        expect(getSocketUrl()).toEqual(asWorker)
        expect(asWorker).toEqual({ url: 'https://flow.aiqadam.org', path: '/api/socket.io' })
    })

    it('returns FRONTEND_URL socket for WORKER', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER'
        process.env.AP_FRONTEND_URL = 'https://flow.aiqadam.org/'
        expect(getSocketUrl()).toEqual({ url: 'https://flow.aiqadam.org', path: '/api/socket.io' })
    })
})

describe('system.getContainerType', () => {
    beforeEach(cleanEnv)
    afterEach(restoreEnv)

    it.each(['APP', 'WORKER'])('accepts %s', (value) => {
        process.env.AP_CONTAINER_TYPE = value
        expect(system.getContainerType()).toBe(value)
    })

    it('rejects an unset value rather than defaulting', () => {
        expect(() => system.getContainerType()).toThrow(/AP_CONTAINER_TYPE is required and has no default/)
    })

    it('names the removed WORKER_AND_APP so an operator on it gets an explanation', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER_AND_APP'
        expect(() => system.getContainerType()).toThrow(/WORKER_AND_APP has been removed/)
    })

    // main.ts only tests `containerType === 'WORKER'` to decide withHealthServer. Without this
    // check a typo would start a worker with its health server silently switched off.
    it.each(['worker', 'BOTH', '   '])('rejects %j instead of silently disabling the health server', (value) => {
        process.env.AP_CONTAINER_TYPE = value
        expect(() => system.getContainerType()).toThrow(/AP_CONTAINER_TYPE/)
    })

    it('tolerates a trailing carriage return from a Windows-edited env file', () => {
        process.env.AP_CONTAINER_TYPE = 'WORKER\r'
        expect(system.getContainerType()).toBe('WORKER')
    })
})
