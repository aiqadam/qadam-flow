import type { LookupAddress, LookupOptions } from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { SSRFBlockedError, tryCatch } from '@aiqadam/shared'
import { Agent, request as undiciRequest } from 'undici'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ssrfGuard } from '../../src/lib/network/ssrf-guard'

const LOOPBACK = '127.0.0.1'
const OTHER_LOOPBACK = '127.0.0.2'

function listen({ server, target }: ListenParams): Promise<void> {
    return new Promise((resolve) => {
        if (typeof target === 'string') server.listen(target, () => resolve())
        else server.listen(target.port, target.host, () => resolve())
    })
}

// Calls Socket#connect with the raw argument list, for shapes the typed overloads do not admit.
function connectWith(connectArgs: unknown[]): net.Socket {
    return Reflect.apply(net.Socket.prototype.connect, new net.Socket(), connectArgs)
}

function firstReadThen<T>({ first, then, firstReads = 1 }: FirstReadThenParams<T>): () => T {
    let reads = 0
    return () => {
        reads += 1
        return reads <= firstReads ? first : then
    }
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
        const connected = (): void => done({
            connected: true,
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
        })
        socket.once('connect', connected)
        socket.once('secureConnect', connected)
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
    const { error } = await tryCatch(() => promise)
    if (error === null) throw new Error('expected the request to be rejected')
    return error
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
        await listen({ server, target: { port: 0, host: LOOPBACK } })
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
            ['net.createConnection(portString, host)', (): net.Socket =>
                Reflect.apply(net.createConnection, undefined, [String(port), LOOPBACK])],
            ['new Socket().connect(options)', (): net.Socket => new net.Socket().connect({ host: LOOPBACK, port })],
            ['new Socket().connect(port, host)', (): net.Socket => new net.Socket().connect(port, LOOPBACK)],
            ['new Socket().connect(portString, host)', (): net.Socket => connectWith([String(port), LOOPBACK])],
            ['new Socket().connect([options, cb]) (pre-normalized tuple)', (): net.Socket =>
                connectWith([[{ host: LOOPBACK, port }, null]])],
            ['tls.connect(options)', (): net.Socket =>
                tls.connect({ host: LOOPBACK, port, rejectUnauthorized: false })],
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
                const requestOptions = { host: 'resolver.test', port, lookup: resolveTo(LOOPBACK), agent: false }
                const req = http.request(requestOptions, () => resolve(undefined))
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

    describe('connects to exactly the target that was checked', () => {
        it.each([
            // Socket's constructor already copies the options here, so this row pins the call shape.
            ['net.connect(options)', (options: net.NetConnectOpts): net.Socket => net.connect(options)],
            ['new Socket().connect(options)', (options: net.NetConnectOpts): net.Socket => connectWith([options])],
            ['new Socket().connect([options, cb])', (options: net.NetConnectOpts): net.Socket =>
                connectWith([[options, null]])],
        ])('refuses a host whose value changes after it is first read: %s', async (_shape, open) => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [] })
            const host = firstReadThen({ first: '', then: LOOPBACK })
            const options = Object.defineProperty({ port }, 'host', { get: host, enumerable: true })
            const outcome = await settle(open(options))
            expect(outcome.connected).toBe(false)
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })

        it('lands on the checked port when the port value changes after it is first read', async () => {
            const otherServer = net.createServer((socket) => socket.end())
            await listen({ server: otherServer, target: { port: 0, host: LOOPBACK } })
            try {
                ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [port] })
                const readPort = firstReadThen({ first: port, then: portOf(otherServer) })
                const options = Object.defineProperty({ host: LOOPBACK }, 'port', { get: readPort, enumerable: true })
                const outcome = await settle(connectWith([options]))
                expect(outcome.connected).toBe(true)
                expect(outcome.remotePort).toBe(port)
            }
            finally {
                await closeServer(otherServer)
            }
        })

        it.each([
            ['inherited from the prototype', (): net.NetConnectOpts =>
                Object.assign(Object.create({ host: LOOPBACK }), { port })],
            ['own but not enumerable', (): net.NetConnectOpts =>
                Object.defineProperty({ port }, 'host', { value: LOOPBACK, enumerable: false })],
        ])('checks a host that is %s against that host', async (_how, buildOptions) => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [] })
            const outcome = await settle(connectWith([buildOptions()]))
            expect(outcome.connected).toBe(false)
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(outcome.error?.message).toContain(`refusing to connect to ${LOOPBACK} `)
            expect(acceptedConnections).toBe(0)
        })

        it.each([
            ['an entry whose address changes after it is read', (): LookupAddress[] => {
                // Two reads answer the checked address, so only the address actually connected to can
                // tell a guard that reads the entry more than once apart from one that reads it once.
                const readAddress = firstReadThen({ first: LOOPBACK, then: OTHER_LOOPBACK, firstReads: 2 })
                return [{ family: 4, get address(): string {
                    return readAddress()
                } }]
            }],
            ['a list whose first entry changes after it is read', (): LookupAddress[] => {
                const readEntry = firstReadThen<LookupAddress>({
                    first: { address: LOOPBACK, family: 4 },
                    then: { address: OTHER_LOOPBACK, family: 4 },
                })
                return new Proxy([{ address: LOOPBACK, family: 4 }], {
                    get: (target, key, receiver) => key === '0' ? readEntry() : Reflect.get(target, key, receiver),
                })
            }],
        ])('connects to exactly the resolved address that was checked: %s', async (_answer, buildAnswer) => {
            ssrfGuard.install({ enabled: true, allowList: [], allowedLoopbackPorts: [port] })
            const answer = buildAnswer()
            const lookup: LookupFn = (_hostname, _options, callback) => {
                callback(null, answer)
            }
            const outcome = await settle(net.connect({ host: 'resolver.test', port, lookup, autoSelectFamily: true }))
            expect(outcome.connected).toBe(true)
            expect(outcome.remoteAddress).toBe(LOOPBACK)
            expect(outcome.remotePort).toBe(port)
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
            const outcome = await settle(connectWith(args))
            expect(outcome.error).toBeInstanceOf(SSRFBlockedError)
            expect(acceptedConnections).toBe(0)
        })
    })

    describe('permitted targets still connect', () => {
        it.each([
            ['net.connect(options)', (): net.Socket => net.connect({ host: LOOPBACK, port })],
            ['net.connect(port, host)', (): net.Socket => net.connect(port, LOOPBACK)],
            ['net.connect with the port as a numeric string', (): net.Socket =>
                Reflect.apply(net.connect, undefined, [{ host: LOOPBACK, port: String(port) }])],
            ['new Socket().connect(portString, host)', (): net.Socket => connectWith([String(port), LOOPBACK])],
            ['new Socket().connect([options, cb]) (pre-normalized tuple)', (): net.Socket =>
                connectWith([[{ host: LOOPBACK, port: String(port) }, null]])],
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
            await listen({ server: ipcServer, target: socketPath })
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

type ListenParams = {
    server: net.Server
    target: { port: number, host: string } | string
}

type FirstReadThenParams<T> = {
    first: T
    then: T
    firstReads?: number
}

type ConnectOutcome = {
    connected: boolean
    error?: Error
    remoteAddress?: string
    remotePort?: number
}
