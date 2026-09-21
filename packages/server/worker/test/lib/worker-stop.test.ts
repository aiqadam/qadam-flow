import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve as resolvePath } from 'node:path'
import {
    createRpcServer,
    WebsocketServerEvent,
} from '@aiqadam/shared'
import type {
    ConsumeJobRequest,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { Server as IOServer } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The worker reads its own release from process.cwd()/package.json at import time, the same way
// apVersionUtil does. Derive it rather than hardcoding a string that will rot — a settings
// response carrying any other value puts the loop in the version-skew branch instead of polling.
const workerVersion: string = JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf-8')).version

vi.mock('../../src/lib/config/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnValue({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}))

import { worker, workerInternals } from '../../src/lib/worker'

/**
 * `stop()`'s postcondition — #500.
 *
 * In the steady state a poll loop is parked inside `apiClient.poll(machineInfo)`, whose
 * server-side budget is 50s and whose client-side RPC timeout is 60s. `stop()` sets `polling =
 * false`, but that flag is only read at the head of the `while`, and the loops were launched as
 * `void startPollingWorkers(...)` with nothing holding them — so `stop()` resolves, logs "Worker
 * stopped", and leaves a worker that is still asking the API for jobs.
 *
 * This is asserted against `workerInternals.activePollLoopCount()` rather than against wall-clock
 * timing, because the interesting state is not "stop() was slow" — it returns in ~20-80ms either
 * way — but "stop() returned while its loops were still running".
 */
describe('worker.stop() — #500', () => {
    let httpServer: ReturnType<typeof createServer>
    let ioServer: IOServer
    let port: number
    let pollCalls: number

    beforeEach(async () => {
        pollCalls = 0

        httpServer = createServer()
        ioServer = new IOServer(httpServer, { transports: ['websocket'], path: '/api/socket.io' })
        await new Promise<void>((resolve) => {
            httpServer.listen(0, () => {
                port = (httpServer.address() as { port: number }).port
                resolve()
            })
        })
        process.env['AP_FRONTEND_URL'] = `http://127.0.0.1:${port}`
        process.env['AP_CONTAINER_TYPE'] = 'WORKER'
        // One loop, so `activePollLoopCount()` reads 1 or 0 and the assertion cannot be satisfied
        // by whichever of five loops happened to unwind first.
        process.env['AP_WORKER_CONCURRENCY'] = '1'

        ioServer.on('connection', (serverSocket) => {
            serverSocket.on(WebsocketServerEvent.FETCH_WORKER_SETTINGS, (...args: unknown[]) => {
                const callback = args[args.length - 1]
                if (typeof callback === 'function') {
                    callback(buildSettingsResponse())
                }
            })

            const handlers: Partial<WorkerToApiContract> = {
                // Parks, exactly as the real long-poll does. The API answers within
                // WAITER_TIMEOUT_MS; nothing here answers until the test says so.
                poll: vi.fn(() => {
                    pollCalls++
                    return new Promise<ConsumeJobRequest | null>(() => {
                        // Never resolves. Parking is the steady state this test is about.
                    })
                }),
                getUsedQadams: vi.fn().mockResolvedValue([]),
                markQadamAsUsed: vi.fn(),
            }
            createRpcServer(serverSocket, handlers as WorkerToApiContract)
        })

        void worker.start({
            apiUrl: `http://127.0.0.1:${port}/api/`,
            socketUrl: { url: `http://127.0.0.1:${port}`, path: '/api/socket.io' },
            workerToken: 'test-token',
        })
    })

    afterEach(async () => {
        await worker.stop()
        delete process.env['AP_WORKER_CONCURRENCY']
        await new Promise<void>((resolve) => {
            ioServer.close(() => resolve())
        })
    })

    // A live loop is not merely untidy. `polling` is not re-read between the poll returning and
    // `executeJob`, so a job handed out in the window between `polling = false` and the socket
    // closing is executed anyway — against sandbox managers `stop()` has already shut down and
    // dropped. That window is a few milliseconds wide and cannot be hit reliably from a test, so
    // it is pinned by the postcondition below rather than by a racy reproduction: a loop that has
    // exited cannot execute anything.
    it('has stopped its poll loops by the time it resolves', async () => {
        await waitUntil(() => pollCalls > 0, 'the worker never reached its first poll')
        expect(workerInternals.activePollLoopCount(), 'the worker was not polling, so this case tests nothing').toBe(1)

        await worker.stop()

        expect(workerInternals.activePollLoopCount(), 'stop() resolved and logged "Worker stopped" while a poll loop was still running').toBe(0)
    }, 20_000)

})

function buildSettingsResponse(): Record<string, unknown> {
    return {
        APP_VERSION: workerVersion,
        PUBLIC_URL: 'http://localhost:3000',
        ENVIRONMENT: 'test',
        EXECUTION_MODE: 'SANDBOX_CODE_AND_PROCESS',
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

async function waitUntil(condition: () => boolean, failureMessage = 'condition was not met', timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) {
            return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out after ${timeoutMs}ms: ${failureMessage}`)
}
