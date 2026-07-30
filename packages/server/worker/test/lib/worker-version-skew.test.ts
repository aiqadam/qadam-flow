import { createServer } from 'node:http'
import {
    createRpcServer,
    WebsocketServerEvent,
} from '@aiqadam/shared'
import { Server as IOServer } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    MachineInformation,
    WorkerToApiContract,
} from '@aiqadam/shared'

// The worker reads its own release from process.cwd()/package.json at import time, the same way
// apVersionUtil does. Derive it rather than hardcoding a string that will rot.
const { workerVersion } = vi.hoisted(() => {
    const fs: typeof import('node:fs') = require('node:fs')
    const path: typeof import('node:path') = require('node:path')
    const packageJson: { version: string } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
    return { workerVersion: packageJson.version }
})

const SKEWED_APP_VERSION = `${workerVersion}-not-this-one`

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

import { worker } from '../../src/lib/worker'

// Both defects in #222 meet here: a worker whose release differs from the app's never completes a
// poll, so before the fix it registered once with empty `workerProps` (no version) and then went
// silent — the API expired nothing and reported nothing useful about the one worker an operator
// was looking at.
describe('version-skewed worker — #222', () => {
    let httpServer: ReturnType<typeof createServer>
    let ioServer: IOServer
    let port: number
    let registrations: MachineInformation[]
    let heartbeats: MachineInformation[]
    let pollCalls: number

    beforeEach(async () => {
        registrations = []
        heartbeats = []
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
        process.env['AP_WORKER_CONCURRENCY'] = '1'

        ioServer.on('connection', (serverSocket) => {
            serverSocket.on(WebsocketServerEvent.FETCH_WORKER_SETTINGS, (...args: unknown[]) => {
                registrations.push(args[0] as MachineInformation)
                const callback = args[args.length - 1]
                if (typeof callback === 'function') {
                    callback(buildSettingsResponse())
                }
            })

            serverSocket.on(WebsocketServerEvent.WORKER_HEALTHCHECK, (machineInfo: MachineInformation) => {
                heartbeats.push(machineInfo)
            })

            const handlers: Partial<WorkerToApiContract> = {
                poll: vi.fn(async () => {
                    pollCalls++
                    return null
                }),
                getUsedQadams: vi.fn().mockResolvedValue([]),
                markQadamAsUsed: vi.fn(),
            }
            createRpcServer(serverSocket, handlers as WorkerToApiContract)
        })

        worker.start({
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

    it('reports its version on the very first registration, before settings are applied', async () => {
        await waitUntil(() => registrations.length > 0)

        expect(registrations[0].workerProps.version).toBe(workerVersion)
    }, 15_000)

    // Deliberately waits for a SECOND heartbeat, not a first. One check-in proves nothing about
    // the case this exists for: the registry entry lives 60s, so what keeps a connected-but-skewed
    // worker visible is the *repetition*. Emitting once per polling loop, or stretching the pause
    // past the TTL, reinstates the exact bug while a `length > 0` assertion stays green.
    it('keeps checking in while it idles on a version mismatch, and says which version it is', async () => {
        // Two heartbeats at VERSION_MISMATCH_POLL_PAUSE_MS apart need more than waitUntil's
        // 10s default, so the budget is explicit rather than inherited.
        await waitUntil(() => heartbeats.length >= 2, 'a version-skewed worker checked in fewer than twice', 25_000)

        expect(heartbeats[0].workerProps.version).toBe(workerVersion)
        expect(heartbeats[0].workerId).toBe(registrations[0].workerId)
        // The gate itself must still hold: an idling skewed worker asks for no jobs.
        expect(pollCalls).toBe(0)
    }, 30_000)

    // The two constants live in different packages and nothing else connects them. If the pause
    // ever exceeds the TTL, a skewed worker expires out of the registry while still connected —
    // which is defect 2 of #222, back again, with every other test still green.
    it('heart-beats well inside the registry TTL', async () => {
        const { VERSION_MISMATCH_POLL_PAUSE_MS } = await import('../../src/lib/worker')
        // 60_000 is WORKER_MACHINE_TTL_SECONDS in packages/server/api. The worker package cannot
        // import from api, so the number is repeated here rather than referenced — which is
        // exactly why it needs an assertion instead of an assumption.
        expect(VERSION_MISMATCH_POLL_PAUSE_MS).toBeLessThan(60_000)
    })
})

function buildSettingsResponse(): Record<string, unknown> {
    return {
        APP_VERSION: SKEWED_APP_VERSION,
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
