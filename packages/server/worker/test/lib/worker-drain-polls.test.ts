import { createServer } from 'node:http'
import {
    createRpcServer,
    EngineResponseStatus,
    PackageType,
    QadamType,
    WebsocketServerEvent,
    WorkerJobType,
} from '@aiqadam/shared'
import type {
    ConsumeJobRequest,
    ExecuteExtractQadamMetadataJobData,
    WorkerSettingsResponse,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { Server as IOServer } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobResultKind } from '../../src/lib/execute/types'
import type { JobContext, JobResult } from '../../src/lib/execute/types'

const { currentAppVersion, runningJobs } = vi.hoisted(() => {
    const fs: typeof import('node:fs') = require('node:fs')
    const path: typeof import('node:path') = require('node:path')
    const packageJson: { version: string } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
    return {
        currentAppVersion: packageJson.version,
        // A job runs until the test finishes it, keyed by the request id its job data carries.
        runningJobs: new Map<string, () => void>(),
    }
})

vi.mock('../../src/lib/execute/job-registry', () => ({
    getHandler: () => ({
        jobType: 'EXECUTE_EXTRACT_PIECE_INFORMATION',
        execute: async (_ctx: JobContext, { requestId }: ExecuteExtractQadamMetadataJobData) => new Promise<JobResult>((resolve) => {
            runningJobs.set(requestId, () => {
                runningJobs.delete(requestId)
                resolve({ kind: JobResultKind.SYNCHRONOUS, status: EngineResponseStatus.OK, response: { ok: true } })
            })
        }),
    }),
}))

vi.mock('../../src/lib/execute/sandbox-manager', () => ({
    createSandboxManager: () => ({
        acquire: vi.fn(() => ({ id: 'sandbox' })),
        prewarm: vi.fn(async () => undefined),
        invalidate: vi.fn(async () => undefined),
        release: vi.fn(),
        markStale: vi.fn(),
        getActiveSandbox: () => null,
        shutdown: vi.fn(async () => undefined),
    }),
}))

vi.mock('../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        set: vi.fn(),
        waitForSettings: vi.fn().mockResolvedValue({ PUBLIC_URL: 'http://localhost:3000', APP_VERSION: currentAppVersion }),
        getSettings: vi.fn(() => baseSettings()),
    },
}))

vi.mock('../../src/lib/config/logger', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() }
    return { logger: { ...log, child: vi.fn(() => log) } }
})

import { worker } from '../../src/lib/worker'

/**
 * #585: a stopping worker used to walk away from the polls its idle slots had parked on the API.
 * They stayed waiters there, so a job enqueued during the drain could be handed to one and acked to
 * a loop that had already stopped: active, unowned, and stuck until the stalled check. Two slots:
 * one busy with a job the test holds, so the drain lasts, and one parked in its poll.
 */
describe('worker drain with a parked poll — #585', () => {
    let httpServer: ReturnType<typeof createServer>
    let ioServer: IOServer
    let port: number
    let dispatcher: FakeDispatcher

    beforeEach(async () => {
        vi.clearAllMocks()
        runningJobs.clear()
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
        process.env['AP_WORKER_CONCURRENCY'] = '2'
    })

    afterEach(async () => {
        runningJobs.forEach((finish) => finish())
        await worker.stop()
        delete process.env['AP_WORKER_CONCURRENCY']
        delete process.env['AP_FRONTEND_URL']
        delete process.env['AP_CONTAINER_TYPE']
        await new Promise<void>((resolve) => {
            ioServer.close(() => resolve())
        })
    })

    it('leaves a job enqueued during the drain in the queue, for a worker that is still polling', async () => {
        dispatcher = startApi({ ioServer, withStopPolling: true })
        await startDrainWithParkedPoll()
        const stopping = worker.stop()
        await waitUntil(() => dispatcher.stopPollingCalls > 0, 'the worker never asked the API to end its parked polls')

        dispatcher.enqueue(buildJob(2))
        runningJobs.get('req-1')?.()
        await stopping

        expect(dispatcher.handedOut, 'a job went to a worker that was stopping').toEqual(['job-1'])
        expect(dispatcher.queued()).toEqual(['job-2'])
        expect(dispatcher.completed).toEqual(['job-1'])
    }, 20_000)

    // An API from before #585 answers `stopPolling` with an error: the parked poll stays a waiter.
    it('runs a job an older API hands to the parked poll during the drain, instead of swallowing it', async () => {
        dispatcher = startApi({ ioServer, withStopPolling: false })
        await startDrainWithParkedPoll()
        const stopping = worker.stop()

        dispatcher.enqueue(buildJob(2))
        await waitUntil(() => runningJobs.has('req-2'), 'the job handed to the parked poll never ran')
        runningJobs.get('req-2')?.()
        runningJobs.get('req-1')?.()
        await stopping

        expect(dispatcher.handedOut).toEqual(['job-1', 'job-2'])
        expect(dispatcher.completed.sort(), 'a job was handed out and never completed').toEqual(['job-1', 'job-2'])
    }, 20_000)

    async function startDrainWithParkedPoll(): Promise<void> {
        dispatcher.enqueue(buildJob(1))
        void worker.start({
            apiUrl: `http://127.0.0.1:${port}/api/`,
            socketUrl: { url: `http://127.0.0.1:${port}`, path: '/api/socket.io' },
            workerToken: 'test-token',
        })
        await waitUntil(() => runningJobs.has('req-1'), 'the first job never started')
        await waitUntil(() => dispatcher.parkedPolls() === 1, 'the idle slot never parked its poll')
    }
})

/**
 * The API's job dispatcher, as far as a worker can see it: a queue, and polls that wait for a job.
 * A job enqueued while a poll waits goes straight to that poll, as `jobBroker.poll` does.
 */
function startApi({ ioServer, withStopPolling }: { ioServer: IOServer, withStopPolling: boolean }): FakeDispatcher {
    const queue: ConsumeJobRequest[] = []
    const waiters: ((job: ConsumeJobRequest | null) => void)[] = []
    const state: FakeDispatcher = {
        handedOut: [],
        completed: [],
        stopPollingCalls: 0,
        queued: () => queue.map(({ jobId }) => jobId),
        parkedPolls: () => waiters.length,
        enqueue: (job) => {
            const waiter = waiters.shift()
            if (waiter) {
                state.handedOut.push(job.jobId)
                waiter(job)
                return
            }
            queue.push(job)
        },
    }
    ioServer.on('connection', (serverSocket) => {
        serverSocket.on(WebsocketServerEvent.FETCH_WORKER_SETTINGS, (...args: unknown[]) => {
            const callback = args[args.length - 1]
            if (typeof callback === 'function') {
                callback(baseSettings())
            }
        })
        let pollingStopped = false
        const handlers: Partial<WorkerToApiContract> = {
            poll: vi.fn(async () => {
                if (pollingStopped) {
                    return null
                }
                const job = queue.shift()
                if (job) {
                    state.handedOut.push(job.jobId)
                    return job
                }
                return new Promise<ConsumeJobRequest | null>((resolve) => {
                    waiters.push(resolve)
                })
            }),
            completeJob: vi.fn(async ({ jobId }) => {
                state.completed.push(jobId)
            }),
            extendLock: vi.fn(async () => ({ leaseLost: false })),
            uploadRunLog: vi.fn(),
            getUsedQadams: vi.fn().mockResolvedValue([]),
            markQadamAsUsed: vi.fn(),
            ...(withStopPolling ? {
                stopPolling: vi.fn(async () => {
                    state.stopPollingCalls++
                    pollingStopped = true
                    waiters.splice(0).forEach((resolve) => resolve(null))
                }),
            } : {}),
        }
        // Built from a partial, as an older API's handler table lacks `stopPolling`.
        createRpcServer(serverSocket, handlers as WorkerToApiContract)
    })
    return state
}

function baseSettings(): Partial<WorkerSettingsResponse> {
    return { APP_VERSION: currentAppVersion, PUBLIC_URL: 'http://localhost:3000', EXECUTION_MODE: 'UNSANDBOXED', SSRF_ALLOW_LIST: [] }
}

function buildJob(n: number): ConsumeJobRequest {
    const jobData: ExecuteExtractQadamMetadataJobData = {
        schemaVersion: 4,
        jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
        projectId: undefined,
        platformId: 'plat-1',
        qadam: {
            qadamName: '@aiqadam/qadam-test',
            qadamVersion: '0.1.0',
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
        },
        requestId: `req-${n}`,
        webserverId: 'ws-1',
    }
    return { jobId: `job-${n}`, jobData, attempsStarted: 0, engineToken: `tok-${n}`, token: `token-${n}`, queueName: 'workerJobs' }
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

type FakeDispatcher = {
    handedOut: string[]
    completed: string[]
    stopPollingCalls: number
    queued: () => string[]
    parkedPolls: () => number
    enqueue: (job: ConsumeJobRequest) => void
}
