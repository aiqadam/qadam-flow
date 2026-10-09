import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import { createRpcServer, WebsocketServerEvent } from '@aiqadam/shared'
import type { ConsumeJobRequest, WorkerToApiContract } from '@aiqadam/shared'
import { Server as IOServer } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const workerVersion: string = JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf-8')).version

const { prepareMock } = vi.hoisted(() => ({ prepareMock: vi.fn() }))

vi.mock('../../src/lib/config/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}))

vi.mock('../../src/lib/sandbox/isolate-preflight', () => ({
    isolatePreflight: { assertRunnable: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../../src/lib/cache/qadams/qadam-version-store-root', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/cache/qadams/qadam-version-store-root')>()
    return { qadamVersionStoreRoot: { ...actual.qadamVersionStoreRoot, prepare: prepareMock } }
})

import { worker, workerInternals } from '../../src/lib/worker'

// #779: the worker opens the qadam version store before its first sandbox exists (an engine's env is
// fixed when it starts), only for the execution modes that use it, and a stop while it waits wins.
describe('worker start and the qadam version store', () => {
    let httpServer: ReturnType<typeof createServer>
    let ioServer: IOServer
    let pollCalls: number
    let executionMode: string

    beforeEach(async () => {
        pollCalls = 0
        prepareMock.mockReset()
        httpServer = createServer()
        ioServer = new IOServer(httpServer, { transports: ['websocket'], path: '/api/socket.io' })
        const port = await new Promise<number>((resolve) => {
            httpServer.listen(0, () => {
                const address = httpServer.address()
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
        process.env['AP_FRONTEND_URL'] = `http://127.0.0.1:${port}`
        process.env['AP_CONTAINER_TYPE'] = 'WORKER'
        process.env['AP_WORKER_CONCURRENCY'] = '1'
        process.env['AP_WORKER_PREWARM_ENGINES'] = 'false'
        ioServer.on('connection', (serverSocket) => {
            serverSocket.on(WebsocketServerEvent.FETCH_WORKER_SETTINGS, (...args: unknown[]) => {
                const callback = args[args.length - 1]
                if (typeof callback === 'function') {
                    callback(buildSettingsResponse({ executionMode }))
                }
            })
            const parked: ((job: ConsumeJobRequest | null) => void)[] = []
            let pollingStopped = false
            const handlers: Partial<WorkerToApiContract> = {
                poll: vi.fn(() => {
                    pollCalls++
                    return pollingStopped ? Promise.resolve(null) : new Promise<ConsumeJobRequest | null>((resolve) => parked.push(resolve))
                }),
                stopPolling: vi.fn(async () => {
                    pollingStopped = true
                    parked.splice(0).forEach((resolve) => resolve(null))
                }),
                getUsedQadams: vi.fn().mockResolvedValue([]),
                markQadamAsUsed: vi.fn(),
            }
            createRpcServer(serverSocket, handlers as WorkerToApiContract)
        })
        startWorker = () => void worker.start({
            apiUrl: `http://127.0.0.1:${port}/api/`,
            socketUrl: { url: `http://127.0.0.1:${port}`, path: '/api/socket.io' },
            workerToken: 'test-token',
        })
    })

    afterEach(async () => {
        await worker.stop()
        for (const key of ['AP_WORKER_CONCURRENCY', 'AP_FRONTEND_URL', 'AP_CONTAINER_TYPE', 'AP_WORKER_PREWARM_ENGINES']) {
            delete process.env[key]
        }
        await new Promise<void>((resolve) => ioServer.close(() => resolve()))
    })

    it('opens the store before it polls in a forked mode', async () => {
        executionMode = 'UNSANDBOXED'
        const prepared = deferred()
        prepareMock.mockReturnValue(prepared.promise)
        startWorker()

        await waitUntil(() => prepareMock.mock.calls.length === 1, 'the worker never opened the store')
        await new Promise<void>((resolve) => setTimeout(resolve, 200))
        expect(pollCalls).toBe(0)

        prepared.resolve()
        await waitUntil(() => pollCalls > 0, 'the worker never polled once the store was open')
    }, 20_000)

    it('starts no poll loop when it is stopped while the store opens', async () => {
        executionMode = 'UNSANDBOXED'
        const prepared = deferred()
        prepareMock.mockReturnValue(prepared.promise)
        startWorker()
        await waitUntil(() => prepareMock.mock.calls.length === 1, 'the worker never opened the store')

        const stopping = worker.stop()
        prepared.resolve()
        await stopping
        await new Promise<void>((resolve) => setTimeout(resolve, 200))

        expect(pollCalls).toBe(0)
        expect(workerInternals.activePollLoopCount()).toBe(0)
    }, 20_000)

    it('does not open the store in an isolate mode', async () => {
        executionMode = 'SANDBOX_CODE_AND_PROCESS'
        startWorker()

        await waitUntil(() => pollCalls > 0, 'the worker never polled')
        expect(prepareMock).not.toHaveBeenCalled()
    }, 20_000)
})

let startWorker: () => void = () => undefined

function deferred(): { promise: Promise<void>, resolve: () => void } {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function buildSettingsResponse({ executionMode }: { executionMode: string }): Record<string, unknown> {
    return {
        APP_VERSION: workerVersion,
        PUBLIC_URL: 'http://localhost:3000',
        ENVIRONMENT: 'test',
        EXECUTION_MODE: executionMode,
        TRIGGER_TIMEOUT_SECONDS: 60,
        TRIGGER_HOOKS_TIMEOUT_SECONDS: 60,
        PAUSED_FLOW_TIMEOUT_DAYS: 30,
        FLOW_TIMEOUT_SECONDS: 600,
        LOG_LEVEL: 'info',
        LOG_PRETTY: 'false',
        APP_WEBHOOK_SECRETS: '{}',
        MAX_FLOW_RUN_LOG_SIZE_MB: 10,
        MAX_FILE_SIZE_MB: 10,
        SANDBOX_MEMORY_LIMIT: '1024',
        SANDBOX_PROPAGATED_ENV_VARS: [],
        DEV_QADAMS: [],
        OTEL_ENABLED: false,
        FILE_STORAGE_LOCATION: '/tmp',
        S3_USE_SIGNED_URLS: 'false',
        EVENT_DESTINATION_TIMEOUT_SECONDS: 30,
    }
}

async function waitUntil(condition: () => boolean, failureMessage: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) {
            return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out after ${timeoutMs}ms: ${failureMessage}`)
}
