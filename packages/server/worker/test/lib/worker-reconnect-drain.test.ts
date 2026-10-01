import { createServer } from 'node:http'
import {
    createRpcServer,
    EngineResponseStatus,
    FlowRunStatus,
    PackageType,
    QadamType,
    tryCatch,
    WebsocketServerEvent,
    WorkerJobType,
} from '@aiqadam/shared'
import type {
    ConsumeJobRequest,
    ExecuteExtractQadamMetadataJobData,
    ExtendLockResponse,
    WorkerSettingsResponse,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { Server as IOServer } from 'socket.io'
import type { Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../src/lib/config/logger'
import { JobGivenUpError } from '../../src/lib/execute/given-up-guard'
import { JobResultKind } from '../../src/lib/execute/types'
import type { JobContext, JobResult } from '../../src/lib/execute/types'

const { currentAppVersion, engine, managers, settingsState, clientSockets, childLog, loopFaults, prewarmControl, leaseDeadline } = vi.hoisted(() => {
    const fs: typeof import('node:fs') = require('node:fs')
    const path: typeof import('node:path') = require('node:path')
    const packageJson: { version: string } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
    const faults = { crashOnNextJob: false }
    const createdManagers: MockSandboxManager[] = []
    const createdSockets: Socket[] = []
    const settings: { current: unknown, sets: number, dropAfterSet: number } = { current: null, sets: 0, dropAfterSet: 0 }
    // Resolves at once unless a test makes it hang, as a prewarm stuck in provisioning would.
    const prewarm = {
        hang: false,
        calls: 0,
        next(): Promise<void> {
            prewarm.calls++
            return prewarm.hang ? new Promise<void>(() => undefined) : Promise.resolve()
        },
    }
    const deadline: { expire: (params: { token: string, leaseAgeMs: number }) => void } = { expire: () => undefined }
    return {
        prewarmControl: prewarm,
        leaseDeadline: deadline,
        currentAppVersion: packageJson.version,
        // Stands in for the engine process of the one slot: a job runs until the test finishes it,
        // or until its sandbox is shut down or invalidated, which is what kills a real engine.
        engine: {
            running: false,
            finish: (): void => undefined,
            kill: (): void => undefined,
            managerShutdowns: 0,
            survivesShutdown: false,
            provisioned: Promise.resolve(),
            failureReports: 0,
            // A progress report the running job sends whenever the test asks, through its own client.
            report: (): Promise<unknown> => Promise.resolve(),
        },
        managers: createdManagers,
        settingsState: settings,
        clientSockets: createdSockets,
        loopFaults: faults,
        childLog: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn((_fields: unknown, message?: string) => {
                // What any unexpected throw inside a poll loop looks like from the outside.
                if (message === 'Job received from poll' && faults.crashOnNextJob) {
                    faults.crashOnNextJob = false
                    throw new Error('poll loop fault')
                }
            }),
        },
    }
})

vi.mock('../../src/lib/execute/job-registry', () => ({
    getHandler: () => ({
        jobType: 'EXECUTE_EXTRACT_PIECE_INFORMATION',
        execute: async (ctx: JobContext) => {
            // Provisioning: installing qadams, or waiting on the shared cache lock.
            await engine.provisioned
            ctx.sandboxManager.acquire({ log: ctx.log, apiClient: ctx.apiClient })
            const { data, error } = await tryCatch(() => new Promise<JobResult>((resolve, reject) => {
                engine.running = true
                engine.report = () => ctx.apiClient.uploadRunLog({ runId: 'run-1', projectId: 'proj-1', status: FlowRunStatus.RUNNING })
                engine.finish = () => {
                    engine.running = false
                    resolve({ kind: JobResultKind.SYNCHRONOUS, status: EngineResponseStatus.OK, response: { ok: true } })
                }
                engine.kill = () => {
                    engine.running = false
                    reject(new Error('Worker exited with code null (killed by shutdown)'))
                }
            }))
            if (error) {
                // What execute-flow does once its engine dies: report the run as failed, then rethrow.
                engine.failureReports++
                await tryCatch(() => ctx.apiClient.uploadRunLog({ runId: 'run-1', projectId: 'proj-1', status: FlowRunStatus.INTERNAL_ERROR }))
                // The verdict that asks the broker for a quick retry (#584): a given-up job must not send
                // it, or the retry would run beside the copy the stalled scan already redelivered.
                const { ClassifiedJobFailure } = await import('../../src/lib/execute/job-failure')
                throw new ClassifiedJobFailure({ original: error, retryable: true })
            }
            return data
        },
    }),
}))

vi.mock('../../src/lib/execute/sandbox-manager', () => ({
    createSandboxManager: () => {
        const manager = {
            // The engine itself is the job handler's promise above; only the id is read off this.
            acquire: vi.fn(() => ({ id: 'sandbox-1' })),
            prewarm: vi.fn(async () => prewarmControl.next()),
            invalidate: vi.fn(async () => {
                if (engine.running) {
                    engine.kill()
                }
            }),
            release: vi.fn(),
            markStale: vi.fn(),
            getActiveSandbox: () => null,
            shutdown: vi.fn(async () => {
                engine.managerShutdowns++
                if (engine.running && !engine.survivesShutdown) {
                    engine.kill()
                }
            }),
        }
        managers.push(manager)
        return manager
    },
}))

// The deadline's timing is the tracker's own test (fake timers); here the test fires it directly.
vi.mock('../../src/lib/lease-tracker', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/lease-tracker')>()
    return {
        leaseTracker: {
            ...actual.leaseTracker,
            create: (params: Parameters<typeof actual.leaseTracker.create>[0]) => {
                leaseDeadline.expire = params.onExpired
                return actual.leaseTracker.create(params)
            },
        },
    }
})

vi.mock('../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        set: vi.fn((settings: unknown) => {
            settingsState.current = settings
            settingsState.sets++
            // A transport drop that lands while the connect handler is still setting up, which is
            // the window its bail-out exists for.
            if (settingsState.sets === settingsState.dropAfterSet) {
                clientSockets[clientSockets.length - 1].io.engine.close()
            }
        }),
        waitForSettings: vi.fn().mockResolvedValue({ PUBLIC_URL: 'http://localhost:3000', APP_VERSION: currentAppVersion }),
        getSettings: vi.fn(() => settingsState.current),
    },
}))

vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>()
    return {
        ...actual,
        io: (...args: Parameters<typeof actual.io>) => {
            const created = actual.io(...args)
            clientSockets.push(created)
            return created
        },
    }
})

vi.mock('../../src/lib/config/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => childLog),
    },
}))

import { leaseTracker } from '../../src/lib/lease-tracker'
import { worker, workerInternals } from '../../src/lib/worker'

/**
 * #585: a reconnect to the API used to shut down every sandbox manager, killing the engines that
 * were mid-job, and a stop gave in-flight jobs 5 s. Here the one slot runs a job the test controls,
 * so "was it killed" and "did it get to report completion" are both observable.
 */
describe('worker reconnect and drain — #585', () => {
    let httpServer: ReturnType<typeof createServer>
    let ioServer: IOServer
    let port: number
    let connections: number
    let pollsByConnection: number[]
    let completeJobCalls: CompleteJobCall[]
    let runLogUploads: RunLogUpload[]
    let extendLockCalls: number[]
    let jobsToHandOut: number
    let jobsHandedOut: number
    let extendLockAnswer: (connection: number) => ExtendLockResponse
    let settingsFor: (connection: number) => Partial<WorkerSettingsResponse>
    let dropBeforeAcking: (connection: number) => boolean
    let settingsAnswered: (connection: number) => Promise<void>

    beforeEach(async () => {
        vi.clearAllMocks()
        connections = 0
        pollsByConnection = []
        completeJobCalls = []
        runLogUploads = []
        extendLockCalls = []
        jobsToHandOut = 1
        jobsHandedOut = 0
        extendLockAnswer = () => ({ leaseLost: false })
        settingsFor = () => baseSettings()
        dropBeforeAcking = () => false
        settingsAnswered = async () => undefined
        engine.running = false
        engine.managerShutdowns = 0
        engine.survivesShutdown = false
        engine.provisioned = Promise.resolve()
        engine.failureReports = 0
        managers.length = 0
        clientSockets.length = 0
        settingsState.current = baseSettings()
        settingsState.sets = 0
        settingsState.dropAfterSet = 0
        loopFaults.crashOnNextJob = false
        prewarmControl.hang = false
        prewarmControl.calls = 0

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
            const connection = connections++
            pollsByConnection[connection] = 0
            serverSocket.on(WebsocketServerEvent.FETCH_WORKER_SETTINGS, (...args: unknown[]) => {
                const callback = args[args.length - 1]
                if (typeof callback === 'function') {
                    void settingsAnswered(connection).then(() => callback(settingsFor(connection)))
                }
            })
            const handlers: Pick<WorkerToApiContract, 'poll' | 'completeJob' | 'extendLock' | 'uploadRunLog' | 'getUsedQadams' | 'markQadamAsUsed'> = {
                poll: vi.fn(async () => {
                    pollsByConnection[connection]++
                    if (jobsHandedOut < jobsToHandOut) {
                        jobsHandedOut++
                        return buildJob(jobsHandedOut)
                    }
                    // Parks, as the real long-poll does.
                    return new Promise<ConsumeJobRequest | null>(() => undefined)
                }),
                completeJob: vi.fn(async (input) => {
                    completeJobCalls.push({ ...input, connection })
                    if (dropBeforeAcking(connection)) {
                        // The API went away after taking the call and before answering it.
                        ioServer.disconnectSockets(true)
                        return new Promise<void>(() => undefined)
                    }
                }),
                extendLock: vi.fn(async () => {
                    extendLockCalls.push(connection)
                    return extendLockAnswer(connection)
                }),
                uploadRunLog: vi.fn(async (input) => {
                    runLogUploads.push({ ...input, connection })
                }),
                getUsedQadams: vi.fn().mockResolvedValue([]),
                markQadamAsUsed: vi.fn(),
            }
            createRpcServer(serverSocket, handlers)
        })

        startWorker()
    })

    function startWorker(): void {
        void worker.start({
            apiUrl: `http://127.0.0.1:${port}/api/`,
            socketUrl: { url: `http://127.0.0.1:${port}`, path: '/api/socket.io' },
            workerToken: 'test-token',
        })
    }

    afterEach(async () => {
        if (engine.running) {
            engine.finish()
        }
        await worker.stop()
        delete process.env['AP_WORKER_CONCURRENCY']
        delete process.env['AP_FRONTEND_URL']
        delete process.env['AP_CONTAINER_TYPE']
        delete process.env['AP_WORKER_SHUTDOWN_GRACE_SECONDS']
        await new Promise<void>((resolve) => {
            ioServer.close(() => resolve())
        })
    })

    it('keeps a running job alive across an API restart, and it completes over the new connection', async () => {
        await waitUntil(() => engine.running, 'the job never started')

        // What a graceful API shutdown does to every worker socket.
        ioServer.disconnectSockets(true)
        await waitUntil(() => connections >= 2 && reconnectedLines() >= 1, 'the worker never reconnected')

        expect(engine.managerShutdowns, 'the reconnect shut down the sandbox manager of a running job').toBe(0)
        expect(engine.running, 'the reconnect killed the running engine').toBe(true)
        expect(workerInternals.activePollLoopCount(), 'the reconnect started a second loop for the same slot').toBe(1)
        expect(pollsByConnection[1], 'the only slot is busy, so nothing may poll for it').toBe(0)
        await waitUntil(() => extendLockCalls.includes(1), 'the reconnect did not renew the lease of the running job')

        engine.finish()
        await waitUntil(() => completeJobCalls.length > 0, 'the job never reported completion')
        expect(completeJobCalls[0]).toMatchObject({ jobId: 'job-1', status: EngineResponseStatus.OK, connection: 1 })
        await waitUntil(() => pollsByConnection[1] > 0, 'the slot never polled again after its job')
    }, 20_000)

    it('drains a job that runs past the old 5 s grace instead of abandoning it', async () => {
        await waitUntil(() => engine.running, 'the job never started')
        const pollsBeforeStop = pollsByConnection[0]

        const stopping = worker.stop()
        await sleep(5_500)
        expect(engine.running, 'stop() killed the job before the grace expired').toBe(true)
        expect(pollsByConnection[0], 'a stopping worker asked for another job').toBe(pollsBeforeStop)

        engine.finish()
        await stopping

        expect(completeJobCalls).toHaveLength(1)
        expect(completeJobCalls[0]).toMatchObject({ jobId: 'job-1', status: EngineResponseStatus.OK })
        expect(logger.info).toHaveBeenCalledWith({ inFlightJobsAtStop: 1, abandonedJobs: 0 }, 'Worker stopped')
    }, 20_000)

    // A deploy that restarts the API and then the workers can stop a worker whose socket is down.
    // Its job can only report completion over a live socket, so the drain has to reconnect.
    it('still reconnects while draining, so a job stopped during an API restart can complete', async () => {
        await waitUntil(() => engine.running, 'the job never started')

        ioServer.disconnectSockets(true)
        const stopping = worker.stop()
        await waitUntil(() => connections >= 2, 'a draining worker did not reconnect')
        expect(pollsByConnection[1], 'a draining worker asked for a new job').toBe(0)

        engine.finish()
        await stopping

        expect(completeJobCalls).toHaveLength(1)
        expect(completeJobCalls[0]).toMatchObject({ jobId: 'job-1', status: EngineResponseStatus.OK, connection: 1 })
        expect(logger.info).toHaveBeenCalledWith({ inFlightJobsAtStop: 1, abandonedJobs: 0 }, 'Worker stopped')
    }, 20_000)

    it('abandons a job still running when the configured grace expires, and says how many', async () => {
        process.env['AP_WORKER_SHUTDOWN_GRACE_SECONDS'] = '0.3'
        await waitUntil(() => engine.running, 'the job never started')

        await worker.stop()

        expect(engine.managerShutdowns).toBe(1)
        expect(logger.warn).toHaveBeenCalledWith({ abandonedJobs: 1, graceMs: 300 }, 'Shutdown grace expired, abandoning in-flight jobs')
        expect(logger.info).toHaveBeenCalledWith({ inFlightJobsAtStop: 1, abandonedJobs: 1 }, 'Worker stopped')
        // Its completion could only wait out the RPC timeout on the socket stop() just closed.
        await waitUntil(() => workerInternals.activePollLoopCount() === 0, 'the abandoned job\'s loop outlived stop()', 1_000)
        expect(jobFinishedLines()[0]).toMatchObject({ jobId: 'job-1', givenUp: 'shutdown', completed: false })
        expect(completeJobCalls).toHaveLength(0)
    }, 20_000)

    // `stopped` is reset by the next start(), so a loop that read it would come back to life on
    // the dead socket of the start it belonged to, beside the new start's own loop for the slot.
    it('does not let a loop that outlived stop() resume polling after the next start()', async () => {
        process.env['AP_WORKER_SHUTDOWN_GRACE_SECONDS'] = '0.3'
        engine.survivesShutdown = true
        await waitUntil(() => engine.running, 'the job never started')

        await worker.stop()
        expect(engine.running, 'the job was meant to outlive stop()').toBe(true)
        startWorker()
        await waitUntil(() => pollsByConnection[1] > 0, 'the restarted worker never polled')

        engine.finish()
        await sleep(300)

        expect(workerInternals.activePollLoopCount(), 'the previous start\'s loop came back').toBe(1)
    }, 20_000)

    describe('lease', () => {
        // Past the lock's life the API's stalled scan re-runs the job elsewhere: a copy kept
        // running here would execute it twice, and its completion would overwrite the other's.
        it('stops a job whose lease the API gave away, and does not report its completion', async () => {
            extendLockAnswer = (connection) => ({ leaseLost: connection > 0 })
            await waitUntil(() => engine.running, 'the job never started')

            ioServer.disconnectSockets(true)
            await waitUntil(() => !engine.running, 'the job kept running after the API refused its lease')

            expect(managers[0].invalidate).toHaveBeenCalled()
            expect(engine.managerShutdowns, 'only the job\'s own sandbox is stopped').toBe(0)
            await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')
            expect(jobFinishedLines()[0]).toMatchObject({ jobId: 'job-1', givenUp: 'lease-lost', completed: false })
            expect(childLog.error, 'the engine the give-up killed was logged as a job failure').not.toHaveBeenCalledWith(expect.anything(), 'Job execution failed')
            expect(childLog.info).toHaveBeenCalledWith(expect.anything(), 'Job stopped: this worker gave it up')
            expect(completeJobCalls, 'a given-up job sent its verdict, and with it a quick retry').toHaveLength(0)
            // The failed run it would report could overwrite the redelivered copy's.
            expect(engine.failureReports, 'the handler never tried to report the dead engine').toBe(1)
            expect(runLogUploads, 'a given-up job reported its run to the API').toEqual([])
            await waitUntil(() => pollsByConnection[1] > 0, 'the slot never polled again')
        }, 20_000)

        it('gives up a lease whose deadline passed during an outage, without asking the API', async () => {
            await waitUntil(() => engine.running, 'the job never started')

            ioServer.disconnectSockets(true)
            await waitUntil(() => warnedWith('Disconnected from API server'), 'the worker never saw the disconnect')
            leaseDeadline.expire({ token: 'token-1', leaseAgeMs: leaseTracker.trustMs })
            await waitUntil(() => !engine.running, 'the job kept running past its lease deadline')
            await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')
            await waitUntil(() => reconnectedLines() >= 1, 'the worker never reconnected')

            expect(childLog.warn).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', reason: 'not renewed in time' }), expect.stringMatching(/^Lease lost/))
            expect(extendLockCalls, 'a given-up lease was renewed anyway').not.toContain(1)
            expect(completeJobCalls).toHaveLength(0)
            expect(runLogUploads).toEqual([])
        }, 20_000)

        // The report waits for the connection with the job still this worker's, and the API comes back
        // only after the give-up: sending it then would write over the redelivered copy's run.
        it('drops a report that was waiting for the reconnect when its job was given up', async () => {
            let answerSettings = (): void => undefined
            settingsAnswered = async (connection) => {
                if (connection > 0) {
                    await new Promise<void>((resolve) => {
                        answerSettings = resolve
                    })
                }
            }
            await waitUntil(() => engine.running, 'the job never started')

            ioServer.disconnectSockets(true)
            await waitUntil(() => connections > 1, 'the worker never reconnected')
            const report = engine.report()
            leaseDeadline.expire({ token: 'token-1', leaseAgeMs: leaseTracker.trustMs })
            await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')
            answerSettings()

            await expect(report).rejects.toBeInstanceOf(JobGivenUpError)
            expect(runLogUploads, 'a held report of a given-up job reached the API').toEqual([])
            expect(completeJobCalls).toHaveLength(0)
        }, 20_000)

        // The same for a renewal: sent after the give-up, it would hold the lock of a job nobody runs,
        // and push its redelivery back by a whole lock duration.
        it('drops a renewal that was waiting for the reconnect when its job was given up', async () => {
            const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
            let answerSettings = (): void => undefined
            settingsAnswered = async (connection) => {
                if (connection > 0) {
                    await new Promise<void>((resolve) => {
                        answerSettings = resolve
                    })
                }
            }
            await waitUntil(() => engine.running, 'the job never started')
            const leaseTick = setIntervalSpy.mock.calls.find(([, ms]) => ms === leaseTracker.renewalIntervalMs)?.[0]
            setIntervalSpy.mockRestore()
            expect(leaseTick, 'the job never scheduled its lease renewal').toBeTypeOf('function')

            ioServer.disconnectSockets(true)
            await waitUntil(() => connections > 1, 'the worker never reconnected')
            // Connected, settings not loaded yet: the gate is closed, so the renewal waits at it.
            leaseTick?.()
            leaseDeadline.expire({ token: 'token-1', leaseAgeMs: leaseTracker.trustMs })
            await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')
            answerSettings()
            await waitUntil(() => reconnectedLines() >= 1, 'the reconnect never finished')
            await sleep(200)

            expect(extendLockCalls, 'a held renewal of a given-up job reached the API').not.toContain(1)
        }, 20_000)

        // Provisioning (installing qadams, waiting on the shared cache lock) can take minutes, all of
        // it before the job has a sandbox to kill.
        it('never gives a sandbox to a job given up while it was still provisioning', async () => {
            let finishProvisioning = (): void => undefined
            engine.provisioned = new Promise<void>((resolve) => {
                finishProvisioning = resolve
            })
            extendLockAnswer = (connection) => ({ leaseLost: connection > 0 })
            await waitUntil(() => jobsHandedOut === 1, 'the job was never handed out')

            ioServer.disconnectSockets(true)
            await waitUntil(() => vi.mocked(childLog.warn).mock.calls.some(([, message]) => typeof message === 'string' && message.startsWith('Lease lost')), 'the refused lease was never given up')
            finishProvisioning()
            await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')

            expect(managers[0].acquire, 'a given-up job was handed a sandbox').not.toHaveBeenCalled()
            expect(jobFinishedLines()[0]).toMatchObject({ jobId: 'job-1', givenUp: 'lease-lost', completed: false })
            expect(completeJobCalls).toHaveLength(0)
            expect(runLogUploads).toEqual([])
        }, 20_000)
    })

    // #419 prewarms each slot before its first poll. The manager outlives a reconnect now, so a
    // reconnect must neither start a second loop (and a second prewarm or a job) on it, nor leave a
    // stop waiting on the stuck one.
    it('does not double up a slot whose prewarm hangs across a reconnect, and a stop is not held up by it', async () => {
        prewarmControl.hang = true
        await waitUntil(() => prewarmControl.calls === 1, 'the slot never prewarmed')

        ioServer.disconnectSockets(true)
        await waitUntil(() => reconnectedLines() >= 1, 'the worker never reconnected')
        await sleep(300)

        expect(prewarmControl.calls, 'the reconnect prewarmed the slot again').toBe(1)
        expect(workerInternals.activePollLoopCount(), 'the reconnect started a second loop for the slot').toBe(1)
        expect(pollsByConnection.reduce((sum, polls) => sum + polls, 0), 'the slot asked for a job while its prewarm was still running').toBe(0)
        expect(managers[0].acquire).not.toHaveBeenCalled()

        const stopStartedAt = Date.now()
        await worker.stop()
        expect(Date.now() - stopStartedAt, 'stop() waited on the stuck prewarm').toBeLessThan(2_000)
        expect(workerInternals.activePollLoopCount()).toBe(0)
        // What makes the manager drop whatever the abandoned prewarm would have started.
        expect(engine.managerShutdowns).toBe(1)
    }, 20_000)

    it('resends a completion the API took but never answered, over the new connection', async () => {
        dropBeforeAcking = (connection) => connection === 0
        await waitUntil(() => engine.running, 'the job never started')

        engine.finish()
        await waitUntil(() => completeJobCalls.length >= 2, 'the completion was not resent after the reconnect')

        expect(completeJobCalls.map(({ connection }) => connection)).toEqual([0, 1])
        await waitUntil(() => jobFinishedLines().length === 1, 'the job never finished')
        expect(jobFinishedLines()[0]).toMatchObject({ jobId: 'job-1', completed: true })
    }, 20_000)

    describe('settings change', () => {
        it('lets a busy sandbox finish its job, and replaces it afterwards', async () => {
            settingsFor = changedSettingsAfterFirstConnection
            await waitUntil(() => engine.running, 'the job never started')

            ioServer.disconnectSockets(true)
            await waitUntil(() => reconnectedLines() >= 1, 'the worker never reconnected')

            expect(managers[0].markStale).toHaveBeenCalledTimes(1)
            expect(managers[0].invalidate).not.toHaveBeenCalled()
            expect(engine.running, 'the settings change killed a running job').toBe(true)
        }, 20_000)

        it('replaces an idle sandbox at once', async () => {
            jobsToHandOut = 0
            settingsFor = changedSettingsAfterFirstConnection
            await waitUntil(() => pollsByConnection[0] > 0, 'the worker never polled')

            ioServer.disconnectSockets(true)
            await waitUntil(() => reconnectedLines() >= 1, 'the worker never reconnected')

            expect(managers[0].invalidate).toHaveBeenCalledTimes(1)
        }, 20_000)

        // The connect that stored the new settings bailed out before comparing them, so the one
        // after it finds its settings unchanged from the previous connection's.
        it('still recycles when the connect that brought the new settings dropped mid-setup', async () => {
            jobsToHandOut = 0
            settingsFor = changedSettingsAfterFirstConnection
            await waitUntil(() => pollsByConnection[0] > 0, 'the worker never polled')
            settingsState.dropAfterSet = 2

            ioServer.disconnectSockets(true)
            await waitUntil(() => settingsState.sets >= 3 && pollsByConnection[2] > 0, 'the worker never reconnected twice')
            // A poll buffered on a gate opened too early reaches the third connection before its
            // handler is done, so give that handler time to log what it would.
            await sleep(300)

            expect(reconnectedLines(), 'the connect that dropped mid-setup carried on as if connected').toBe(1)
            expect(managers[0].markStale).toHaveBeenCalledTimes(1)
            expect(managers[0].invalidate).toHaveBeenCalledTimes(1)
        }, 20_000)
    })

    it('restarts a poll loop that threw, without a second loop for the slot, and a stop still drains it', async () => {
        jobsToHandOut = 2
        loopFaults.crashOnNextJob = true
        await waitUntil(() => engine.running, 'the restarted loop never ran the next job')

        expect(childLog.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'Polling worker crashed, restarting it')
        expect(workerInternals.activePollLoopCount()).toBe(1)

        const stopping = worker.stop()
        await sleep(300)
        expect(engine.running, 'stop() did not wait for the job of the restarted loop').toBe(true)
        engine.finish()
        await stopping

        expect(completeJobCalls.map(({ jobId }) => jobId)).toEqual(['job-2'])
        expect(logger.info).toHaveBeenCalledWith({ inFlightJobsAtStop: 1, abandonedJobs: 0 }, 'Worker stopped')
    }, 20_000)
})

function baseSettings(): Partial<WorkerSettingsResponse> {
    return { APP_VERSION: currentAppVersion, PUBLIC_URL: 'http://localhost:3000', EXECUTION_MODE: 'UNSANDBOXED', SSRF_ALLOW_LIST: [] }
}

function changedSettingsAfterFirstConnection(connection: number): Partial<WorkerSettingsResponse> {
    return { ...baseSettings(), SSRF_ALLOW_LIST: connection === 0 ? [] : ['10.0.0.1'] }
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

function reconnectedLines(): number {
    return vi.mocked(logger.info).mock.calls.filter(([, message]) => message === 'Reconnected: in-flight jobs keep running, polling resumes').length
}

function warnedWith(message: string): boolean {
    return vi.mocked(logger.warn).mock.calls.some(([, logged]) => logged === message)
}

function jobFinishedLines(): unknown[] {
    return childLog.info.mock.calls.filter(([, message]) => message === '[worker] Job finished').map(([fields]) => fields)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(condition: () => boolean, failureMessage: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (condition()) {
            return
        }
        await sleep(50)
    }
    throw new Error(`Timed out after ${timeoutMs}ms: ${failureMessage}`)
}

type CompleteJobCall = Parameters<WorkerToApiContract['completeJob']>[0] & { connection: number }

type RunLogUpload = Parameters<WorkerToApiContract['uploadRunLog']>[0] & { connection: number }

type MockSandboxManager = {
    acquire: ReturnType<typeof vi.fn>
    prewarm: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
    markStale: ReturnType<typeof vi.fn>
    shutdown: ReturnType<typeof vi.fn>
}
