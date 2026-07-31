import { MachineInformation, PrincipalType, WebsocketServerEvent, WorkerPrincipal } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Socket } from 'socket.io'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const onConnection = vi.fn().mockResolvedValue({ PUBLIC_URL: 'https://example.com' })
const createHandlers = vi.fn().mockReturnValue({})
const createRpcServer = vi.fn()
const addListener = vi.fn()

vi.mock('../../../../../src/app/core/websockets.service', () => ({
    websocketService: {
        addListener: (...args: unknown[]) => addListener(...args),
    },
}))

const settingsOnly = vi.fn().mockResolvedValue({ ENVIRONMENT: 'test' })

vi.mock('../../../../../src/app/workers/machine/machine-service', () => ({
    machineService: () => ({ onConnection, onDisconnect: vi.fn(), settingsOnly }),
}))

vi.mock('../../../../../src/app/workers/rpc/worker-rpc-service', () => ({
    createHandlers: (...args: unknown[]) => createHandlers(...args),
}))

vi.mock('../../../../../src/app/workers/job-queue/job-queue', () => ({
    jobQueue: () => ({ getAllQueues: () => [] }),
}))

vi.mock('@aiqadam/shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/shared')>()
    return {
        ...actual,
        createRpcServer: (...args: unknown[]) => createRpcServer(...args),
    }
})

import { workerMachineController } from '../../../../../src/app/workers/machine/machine-controller'

const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

const validPayload: MachineInformation = {
    workerId: 'worker-1',
    cpuUsagePercentage: 10,
    ramUsagePercentage: 20,
    totalAvailableRamInBytes: 1024,
    totalCpuCores: 2,
    ip: '10.0.0.1',
    workerProps: { version: '1.0.0' },
    sandboxes: [],
    diskInfo: { total: 100, free: 50, used: 50, percentage: 50 },
}

// A worker that names a group it was not issued: the whole point of #207 is that this is ignored.
function socketClaiming(workerGroupId: string): Socket {
    return { handshake: { auth: { workerId: 'worker-1', workerGroupId } }, on: vi.fn() } as unknown as Socket
}

function workerPrincipal(workerGroupId?: string): WorkerPrincipal {
    return { id: 'principal-1', type: PrincipalType.WORKER, ...(workerGroupId ? { workerGroupId } : {}) }
}

type WorkerHandler = (data: unknown, principal: WorkerPrincipal, projectId: null, callback?: (data: unknown) => void) => Promise<void>

async function handlerFor(event: WebsocketServerEvent, socket: Socket): Promise<WorkerHandler> {
    const fastify = { log, get: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workerMachineController(fastify as any, {} as any)
    const registration = addListener.mock.calls.find(call => call[0] === PrincipalType.WORKER && call[1] === event)
    if (!registration) {
        throw new Error(`No listener registered for ${event}`)
    }
    return registration[2](socket)
}

describe('worker group comes from the verified token, never the handshake', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('ignores a workerGroupId the worker asserts in handshake.auth on FETCH_WORKER_SETTINGS', async () => {
        const socket = socketClaiming('victim-group')
        const handler = await handlerFor(WebsocketServerEvent.FETCH_WORKER_SETTINGS, socket)

        await handler(validPayload, workerPrincipal(), null)

        expect(onConnection).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-1' }), undefined)
        expect(createHandlers).toHaveBeenCalledWith(log, undefined)
    })

    it('ignores a workerGroupId the worker asserts in handshake.auth on WORKER_HEALTHCHECK', async () => {
        const socket = socketClaiming('victim-group')
        const handler = await handlerFor(WebsocketServerEvent.WORKER_HEALTHCHECK, socket)

        await handler(validPayload, workerPrincipal(), null)

        expect(onConnection).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-1' }), undefined)
    })

    it('uses the group from the token even when the handshake asserts a different one', async () => {
        const socket = socketClaiming('victim-group')
        const handler = await handlerFor(WebsocketServerEvent.FETCH_WORKER_SETTINGS, socket)

        await handler(validPayload, workerPrincipal('token-group'), null)

        expect(onConnection).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-1' }), 'token-group')
        expect(createHandlers).toHaveBeenCalledWith(log, 'token-group')
    })

    it('resolves a legacy token with no claim to no group, so the worker stays shared', async () => {
        const socket = { handshake: { auth: { workerId: 'worker-1' } }, on: vi.fn() } as unknown as Socket
        const handler = await handlerFor(WebsocketServerEvent.FETCH_WORKER_SETTINGS, socket)

        await handler(validPayload, workerPrincipal(), null)

        expect(onConnection).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-1' }), undefined)
        expect(createHandlers).toHaveBeenCalledWith(log, undefined)
    })
})

describe('healthcheck payloads are validated before they are stored', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    // Fail closed on storage, open on liveness. Withholding the ack instead would wedge the
    // worker for good: `fetchAndStoreSettings` awaits it with no timeout, on a socket that stays
    // connected, so nothing reconnects and nothing logs on the worker side. The fields that
    // realistically fail this parse are telemetry the worker does not choose — a `si.mem()`
    // fallback yielding NaN is enough — so the cost of getting this backwards is an outage
    // caused by a memory reading.
    it('does not store a malformed payload on FETCH_WORKER_SETTINGS, but still lets the worker boot', async () => {
        const socket = socketClaiming('any-group')
        const handler = await handlerFor(WebsocketServerEvent.FETCH_WORKER_SETTINGS, socket)
        const callback = vi.fn()

        await handler({ ...validPayload, ip: { $ne: null } }, workerPrincipal(), null, callback)

        expect(onConnection).not.toHaveBeenCalled()
        expect(callback).toHaveBeenCalledTimes(1)
        expect(createRpcServer).toHaveBeenCalledTimes(1)
    })

    it('rejects a malformed payload on WORKER_HEALTHCHECK without storing', async () => {
        const socket = socketClaiming('any-group')
        const handler = await handlerFor(WebsocketServerEvent.WORKER_HEALTHCHECK, socket)

        await handler({ workerId: 'worker-1' }, workerPrincipal(), null)

        expect(onConnection).not.toHaveBeenCalled()
    })

    it('accepts a well-formed payload and stores the parsed value', async () => {
        const socket = socketClaiming('any-group')
        const handler = await handlerFor(WebsocketServerEvent.FETCH_WORKER_SETTINGS, socket)
        const callback = vi.fn()

        await handler({ ...validPayload, unexpectedField: 'dropped' }, workerPrincipal(), null, callback)

        expect(onConnection).toHaveBeenCalledWith(validPayload, undefined)
        expect(callback).toHaveBeenCalledTimes(1)
        expect(createRpcServer).toHaveBeenCalledTimes(1)
    })
})
