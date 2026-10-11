/**
 * A worker that disconnects leaves the machine registry at once, not when its entry's TTL runs out
 * (#825). Nothing used to call `machineService.onDisconnect`: the server-level `disconnect`
 * listener never fires, and the per-socket one was registered under 'DISCONNECT' instead of
 * socket.io's lowercase 'disconnect'. Everything here goes over a live socket, since a disconnect
 * only exists on one.
 */
import { MachineInformation, WebsocketServerEvent } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { Socket as ClientSocket, io as ioClient } from 'socket.io-client'
import { worker } from '../../../../../worker/src/lib/worker'
import { WORKER_MACHINE_TTL_SECONDS, workerMachineCache } from '../../../../src/app/workers/machine/machine-cache'
import { setupE2eEnvironment } from '../../../helpers/e2e-setup'
import { workerSuiteTeardown } from '../../../helpers/worker-teardown'

// Well under the registry TTL: an entry that is gone by now was removed by the disconnect, not by
// Redis expiring it.
const REMOVAL_WINDOW_MS = 10_000
// How long an entry that must survive is watched, after the server has seen the socket close.
const SURVIVAL_WINDOW_MS = 500

let app: FastifyInstance
let apiUrl: string
let workerToken: string
const clients: ClientSocket[] = []

beforeAll(async () => {
    const ctx = await setupE2eEnvironment()
    app = ctx.app
    apiUrl = ctx.apiUrl
    workerToken = ctx.workerToken
}, 30_000)

afterAll(async () => {
    clients.forEach((client) => client.disconnect())
    await workerSuiteTeardown.run({ app })
}, workerSuiteTeardown.timeoutMs)

beforeEach(async () => {
    await clearRegistry()
})

describe('a disconnecting worker leaves the machine registry (#825)', () => {
    it('drops a real worker as soon as it stops, long before its TTL', async () => {
        expect(REMOVAL_WINDOW_MS).toBeLessThan(WORKER_MACHINE_TTL_SECONDS * 1000)
        await worker.start({
            apiUrl,
            socketUrl: { url: apiUrl, path: '/api/socket.io' },
            workerToken,
        })
        await waitFor({ describe: 'the worker to register', fn: async () => (await workerMachineCache().find()).length > 0 })

        await worker.stop()

        await waitFor({ describe: 'the registry to empty', fn: async () => (await workerMachineCache().find()).length === 0 })
    }, 40_000)

    it('removes a worker whose socket closes', async () => {
        const client = await connectWorker({ workerId: 'disconnect-single' })
        await register({ client, workerId: 'disconnect-single' })
        expect(await workerMachineCache().findOne('disconnect-single')).not.toBeNull()

        client.disconnect()

        await waitFor({ describe: 'the entry to be removed', fn: async () => (await workerMachineCache().findOne('disconnect-single')) === null })
    })

    it('keeps the entry when an older socket of the same worker closes after a reconnect', async () => {
        const older = await connectWorker({ workerId: 'disconnect-reconnect' })
        await register({ client: older, workerId: 'disconnect-reconnect' })
        const newer = await connectWorker({ workerId: 'disconnect-reconnect' })
        await register({ client: newer, workerId: 'disconnect-reconnect' })

        const olderServerId = older.id
        if (olderServerId === undefined) {
            throw new Error('the older socket has no id')
        }
        older.disconnect()
        await waitFor({ describe: 'the server to see the older socket close', fn: () => !app.io.sockets.sockets.has(olderServerId) })
        await new Promise((resolve) => setTimeout(resolve, SURVIVAL_WINDOW_MS))

        expect(await workerMachineCache().findOne('disconnect-reconnect')).not.toBeNull()

        newer.disconnect()
        await waitFor({ describe: 'the entry to be removed with the last socket', fn: async () => (await workerMachineCache().findOne('disconnect-reconnect')) === null })
    })

    it('does not let a client run the disconnect listener by emitting the event name itself', async () => {
        const client = await connectWorker({ workerId: 'disconnect-forged' })
        await register({ client, workerId: 'disconnect-forged' })

        client.emit(WebsocketServerEvent.DISCONNECT)
        await new Promise((resolve) => setTimeout(resolve, SURVIVAL_WINDOW_MS))

        expect(await workerMachineCache().findOne('disconnect-forged')).not.toBeNull()
    })
})

async function clearRegistry(): Promise<void> {
    const registered = await workerMachineCache().find()
    await workerMachineCache().delete(registered.map((machine) => machine.id))
}

async function connectWorker({ workerId }: ConnectWorkerParams): Promise<ClientSocket> {
    const client = ioClient(apiUrl, {
        path: '/api/socket.io',
        transports: ['websocket'],
        auth: { token: workerToken, workerId },
        reconnection: false,
    })
    clients.push(client)
    await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve())
        client.once('connect_error', reject)
    })
    return client
}

async function register({ client, workerId }: RegisterParams): Promise<void> {
    await new Promise<void>((resolve) => {
        client.emit(WebsocketServerEvent.FETCH_WORKER_SETTINGS, machineInformation(workerId), () => resolve())
    })
}

function machineInformation(workerId: string): MachineInformation {
    return {
        workerId,
        cpuUsagePercentage: 10,
        ramUsagePercentage: 20,
        totalAvailableRamInBytes: 1024,
        totalCpuCores: 2,
        ip: '10.0.0.1',
        workerProps: { version: '1.0.0' },
        sandboxes: [],
        diskInfo: { total: 100, free: 50, used: 50, percentage: 50 },
    }
}

async function waitFor({ describe: what, fn, timeoutMs = REMOVAL_WINDOW_MS }: WaitForParams): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
}

type ConnectWorkerParams = {
    workerId: string
}

type RegisterParams = {
    client: ClientSocket
    workerId: string
}

type WaitForParams = {
    describe: string
    fn: () => boolean | Promise<boolean>
    timeoutMs?: number
}
