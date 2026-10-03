import type { LookupAddress, LookupOptions } from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { SSRFBlockedError } from '@aiqadam/shared'
import { Agent, request as undiciRequest } from 'undici'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ssrfGuard } from '../../src/lib/network/ssrf-guard'

const LOOPBACK = '127.0.0.1'

function listen(server: net.Server, target: { port: number, host: string } | string): Promise<void> {
    return new Promise((resolve) => {
        if (typeof target === 'string') server.listen(target, () => resolve())
        else server.listen(target.port, target.host, () => resolve())
    })
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()))
}

function portOf(server: net.Server): number {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server is not listening on TCP')
    return address.port
}

function settle(socket: net.Socket): Promise<ConnectOutcome> {
    return new Promise((resolve) => {
        const done = (outcome: ConnectOutcome): void => {
            socket.removeAllListeners()
            socket.on('error', () => undefined)
            socket.destroy()
            resolve(outcome)
        }
        socket.once('connect', () => done({ connected: true }))
        socket.once('secureConnect', () => done({ connected: true }))
        socket.once('error', (error) => done({ connected: false, error }))
    })
}

function resolveTo(address: string): LookupFn {
    return (_hostname, options, callback) => {
        if (options.all === true) callback(null, [{ address, family: 4 }])
        else callback(null, address, 4)
    }
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise
    }
    catch (error) {
        return error
    }
    throw new Error('expected the request to be rejected')
}

function causeOf(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined
}

describe('socket connect guard — every connect argument shape', () => {
    let server: net.Server
    let port: number
    let acceptedConnections: number

    beforeAll(async () => {
        server = http.createServer((_req, res) => res.end('ok'))
        server.on('connection', () => {
            acceptedConnections += 1
        })
        await listen(server, { port: 0, host: LOOPBACK })
        port = portOf(server)
    })

    afterAll(async () => {
        await closeServer(server)
    })

    beforeEach(() => {
        acceptedConnections = 0
    })

    afterEach(() => {
        ssrfGuard.uninstall()
    })

    describe('a private IP literal is refused whichever way the target is passed', () => {
        beforeEach(() => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [] })
        })

        it.each([
            ['net.connect(options)', (): net.Socket => net.connect({ host: LOOPBACK, port })],
            ['net.connect(port, host)', (): net.Socket => net.connect(port, LOOPBACK)],
            ['net.createConnection(options)', (): net.Socket => net.createConnection({ host: LOOPBACK, port })],
            ['net.createConnection(portString, host)', (): net.Socket => Reflect.apply(net.createConnection, undefined, [String(port), LOOPBACK])],
            ['new Socket().connect(options)', (): net.Socket => new net.Socket().connect({ host: LOOPBACK, port })],
            ['new Socket().connect(port, host)', (): net.Socket => new net.Socket().connect(port, LOOPBACK)],
            ['new Socket().connect(portString, host)', (): net.Socket => Reflect.apply(net.Socket.prototype.connect, new net.Socket(), [String(port), LOOPBACK])],
            ['new Socket().connect([options, cb]) (pre-normalized tuple)', (): net.Socket => Reflect.apply(net.Socket.prototype.connect, new net.Socket(), [[{ host: LOOPBACK, port }, null]])],
            ['tls.connect(options)', (): net.Socket => tls.connect({ host: LOOPBACK, port, rejectUnauthorized: false })],
            ['tls.connect(port, host)', (): net.Socket => tls.connect(port, LOOPBACK, { rejectUnauthorized: false })],
        ])('%s', async (_shape, open) => {
            const outcome = await settle(open())
            expect(outcome.connected).toBe(false)
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it.each([
            ['the global agent', undefined],
            ['a one-off agent', false],
            ['a keep-alive agent', new http.Agent({ keepAlive: true })],
        ])('http.request through %s reports the refusal on the request itself', async (_agent, agent) => {
            const error = await new Promise<unknown>((resolve) => {
                const req = http.request({ host: LOOPBACK, port, agent }, () => resolve(undefined))
                req.on('error', resolve)
                req.end()
            })
            expect(error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('global fetch', async () => {
            const error = await captureRejection(fetch(`http://${LOOPBACK}:${port}/`))
            expect(causeOf(error)).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('undici request', async () => {
            const dispatcher = new Agent()
            try {
                const error = await captureRejection(undiciRequest(`http://${LOOPBACK}:${port}/`, { dispatcher }))
                expect(error).toBeInstanceOf(SSRFBlockedError)
                expect(acceptedConnections).toBe(0)
            }
            finally {
                await dispatcher.close()
            }
        })
    })

    describe('a caller-supplied resolver is checked like the system resolver', () => {
        beforeEach(() => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [] })
        })

        it('refuses net.connect when the lookup option answers with a private address', async () => {
            const outcome = await settle(net.connect({ host: 'resolver.test', port, lookup: resolveTo(LOOPBACK) }))
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('refuses net.connect when the lookup option answers with a list holding a private address', async () => {
            const lookup: LookupFn = (_hostname, _options, callback) => {
                callback(null, [{ address: '8.8.8.8', family: 4 }, { address: LOOPBACK, family: 4 }])
            }
            const outcome = await settle(net.connect({ host: 'resolver.test', port, lookup, autoSelectFamily: true }))
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('refuses http.request when the lookup option answers with a private address', async () => {
            const error = await new Promise<unknown>((resolve) => {
                const req = http.request({ host: 'resolver.test', port, lookup: resolveTo(LOOPBACK), agent: false }, () => resolve(undefined))
                req.on('error', resolve)
                req.end()
            })
            expect(error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('passes the resolver error through untouched', async () => {
            const lookupError = Object.assign(new Error('getaddrinfo ENOTFOUND resolver.test'), { code: 'ENOTFOUND' })
            const lookup: LookupFn = (_hostname, _options, callback) => {
                callback(lookupError, '', 0)
            }
            const outcome = await settle(net.connect({ host: 'resolver.test', port, lookup }))
            expect(outcome.error).toBe(lookupError)
        })
    })

    describe('argument shapes the guard cannot read are refused', () => {
        beforeEach(() => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [port] })
        })

        it.each([
            ['an empty tuple', [[]]],
            ['a tuple whose options are not an object', [[String(port), null]]],
            ['a tuple with a non-function callback', [[{ host: LOOPBACK, port }, 'not-a-callback']]],
            ['a tuple followed by extra arguments', [[{ host: LOOPBACK, port }, null], LOOPBACK]],
            ['a non-string host', [{ host: 2130706433, port }]],
            ['a non-function lookup on a hostname target', [{ host: 'resolver.test', port, lookup: 'not-a-function' }]],
        ])('%s', async (_shape, args) => {
            const outcome = await settle(Reflect.apply(net.Socket.prototype.connect, new net.Socket(), args))
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })
    })

    describe('permitted targets still connect', () => {
        it.each([
            ['net.connect(options)', (): net.Socket => net.connect({ host: LOOPBACK, port })],
            ['net.connect(port, host)', (): net.Socket => net.connect(port, LOOPBACK)],
            ['net.connect with the port as a numeric string', (): net.Socket => Reflect.apply(net.connect, undefined, [{ host: LOOPBACK, port: String(port) }])],
            ['new Socket().connect(portString, host)', (): net.Socket => Reflect.apply(net.Socket.prototype.connect, new net.Socket(), [String(port), LOOPBACK])],
            ['new Socket().connect([options, cb]) (pre-normalized tuple)', (): net.Socket => Reflect.apply(net.Socket.prototype.connect, new net.Socket(), [[{ host: LOOPBACK, port: String(port) }, null]])],
        ])('a loopback port on the allowed list: %s', async (_shape, open) => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [port] })
            const outcome = await settle(open())
            expect(outcome.connected).toBe(true)
        })

        it('keeps the connect callback bound to the socket', async () => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [port] })
            const boundTo = await new Promise<unknown>((resolve) => {
                const socket = new net.Socket()
                socket.connect(port, LOOPBACK, function onConnect(this: unknown) {
                    socket.destroy()
                    resolve(this === socket)
                })
            })
            expect(boundTo).toBe(true)
        })

        it('global fetch to an allow-listed address', async () => {
            ssrfGuard.install({ enabled: true, allowList: [LOOPBACK], allowedLoopbackPorts: [] })
            const response = await fetch(`http://${LOOPBACK}:${port}/`)
            expect(await response.text()).toBe('ok')
        })

        it('undici request to an allow-listed address', async () => {
            ssrfGuard.install({ enabled: true, allowList: [LOOPBACK], allowedLoopbackPorts: [] })
            const dispatcher = new Agent()
            try {
                const response = await undiciRequest(`http://${LOOPBACK}:${port}/`, { dispatcher })
                expect(await response.body.text()).toBe('ok')
            }
            finally {
                await dispatcher.close()
            }
        })

        it('a caller-supplied resolver answering with an allow-listed address connects', async () => {
            ssrfGuard.install({ enabled: true, allowList: [LOOPBACK], allowedLoopbackPorts: [] })
            const outcome = await settle(net.connect({ host: 'resolver.test', port, lookup: resolveTo(LOOPBACK) }))
            expect(outcome.connected).toBe(true)
        })

        it('an IPC path is not subject to the IP check', async () => {
            const dir = mkdtempSync(path.join(tmpdir(), 'socket-guard-'))
            const socketPath = path.join(dir, 'ipc.sock')
            const ipcServer = net.createServer((socket) => socket.end())
            await listen(ipcServer, socketPath)
            try {
                ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [] })
                expect((await settle(net.connect({ path: socketPath }))).connected).toBe(true)
                expect((await settle(net.connect(socketPath))).connected).toBe(true)
            }
            finally {
                await closeServer(ipcServer)
                rmSync(dir, { recursive: true, force: true })
            }
        })
    })
})

type LookupFn = (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void

type ConnectOutcome = {
    connected: boolean
    error?: Error
}
