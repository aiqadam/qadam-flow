import { createServer, Server as HttpServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'

const { warmupRunMock } = vi.hoisted(() => ({ warmupRunMock: vi.fn() }))

vi.mock('../src/lib/helper/engine-warmup', () => ({
    engineWarmup: {
        isEnabled: () => process.env.AP_ENGINE_WARMUP === 'true',
        run: warmupRunMock,
    },
}))

import { workerSocket } from '../src/lib/worker-socket'

// #419: the engine's console is patched to also send every line to the worker over the notify
// channel, and the worker captures that channel into the running job's logs. The warmup runs while
// the first job may already be executing, so its line must go to the process's own stdout only.
describe('workerSocket.init — engine warmup output (#419)', () => {
    const originalConsole = { log: console.log, warn: console.warn, error: console.error }
    let httpServer: HttpServer
    let io: SocketIOServer
    let notified: string[]
    let previousEnv: { port: string | undefined, warmup: string | undefined }

    beforeEach(async () => {
        notified = []
        httpServer = createServer()
        io = new SocketIOServer(httpServer, { path: '/worker/ws' })
        io.on('connection', (socket) => {
            socket.on('rpc-notify', (event: { payload?: { message?: string } }) => {
                notified.push(String(event.payload?.message ?? ''))
            })
        })
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
        const address = httpServer.address()
        if (typeof address !== 'object' || address === null) {
            throw new Error('test socket server has no port')
        }
        const { port } = address
        previousEnv = { port: process.env.AP_SANDBOX_WS_PORT, warmup: process.env.AP_ENGINE_WARMUP }
        process.env.AP_SANDBOX_WS_PORT = String(port)
        process.env.AP_ENGINE_WARMUP = 'true'
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    })

    afterEach(async () => {
        workerSocket.disconnect()
        console.log = originalConsole.log
        console.warn = originalConsole.warn
        console.error = originalConsole.error
        vi.restoreAllMocks()
        warmupRunMock.mockReset()
        restoreEnv({ key: 'AP_SANDBOX_WS_PORT', value: previousEnv.port })
        restoreEnv({ key: 'AP_ENGINE_WARMUP', value: previousEnv.warmup })
        io.close()
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    })

    it('runs the warmup once connected, and its line never reaches the notify channel', async () => {
        warmupRunMock.mockImplementation(async ({ write }: { write: (line: string) => void }) => {
            write('[engineWarmup] done {}')
        })

        workerSocket.init('sandbox-warmup-test')
        await vi.waitFor(() => expect(warmupRunMock).toHaveBeenCalledTimes(1))
        console.log('[probe] through the patched console')
        await vi.waitFor(() => expect(notified.join('')).toContain('[probe] through the patched console'))

        expect(notified.join('')).not.toContain('[engineWarmup]')
    })

    it('does not run the warmup unless the worker asked for it', async () => {
        process.env.AP_ENGINE_WARMUP = 'false'

        workerSocket.init('sandbox-no-warmup-test')
        console.log('[probe] connected')
        await vi.waitFor(() => expect(notified.join('')).toContain('[probe] connected'))

        expect(warmupRunMock).not.toHaveBeenCalled()
    })
})

function restoreEnv({ key, value }: { key: string, value: string | undefined }): void {
    if (value === undefined) {
        delete process.env[key]
    }
    else {
        process.env[key] = value
    }
}
