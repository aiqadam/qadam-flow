import { QadamEventPuller, QadamEventPullOutcome } from '@aiqadam/qadams-framework'
import { AppConnectionStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LongPollingSource } from '../../../../../src/app/trigger/long-polling/long-polling-source'

const QADAM_NAME = '@aiqadam/qadam-telegram-bot'
const CREDENTIAL_KEY = 'bot-777'

const listSources = vi.fn()
const handleWebhook = vi.fn()
const lockAndRefreshConnection = vi.fn()
const getPuller = vi.fn()
const runExclusive = vi.fn()
const connectionExistsBy = vi.fn()
const reportStatus = vi.fn()
const clearStatus = vi.fn()
const store = new Map<string, unknown>()
let longPollingEnabled = true

vi.mock('../../../../../src/app/trigger/long-polling/long-polling-source', () => ({
    longPollingSourceRegistry: () => ({ list: listSources }),
}))

vi.mock('../../../../../src/app/trigger/long-polling/event-puller-registry', () => ({
    eventPullerRegistry: {
        load: async () => undefined,
        isRegistered: (qadamName: string) => qadamName === QADAM_NAME,
        getOrLoad: async (qadamName: string) => getPuller(qadamName),
        qadamNames: () => [QADAM_NAME],
        get: (qadamName: string) => getPuller(qadamName),
    },
}))

vi.mock('../../../../../src/app/webhooks/webhook.service', () => ({
    WebhookFlowVersionToRun: { LOCKED_FALL_BACK_TO_LATEST: 'locked_fall_back_to_latest' },
    webhookService: { handleWebhook: (...args: unknown[]) => handleWebhook(...args) },
}))

vi.mock('../../../../../src/app/app-connection/app-connection-service/app-connection.handler', () => ({
    appConnectionHandler: () => ({ lockAndRefreshConnection }),
}))

vi.mock('../../../../../src/app/app-connection/app-connection-service/app-connection-service', () => ({
    appConnectionsRepo: () => ({ existsBy: connectionExistsBy }),
}))

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({ runExclusive: (params: LockParams) => runExclusive(params) }),
    distributedStore: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: unknown) => {
            store.set(key, value)
        },
    },
}))

vi.mock('../../../../../src/app/trigger/long-polling/long-polling-status', () => ({
    longPollingStatus: {
        report: (...args: unknown[]) => reportStatus(...args),
        clear: (...args: unknown[]) => clearStatus(...args),
    },
}))

vi.mock('../../../../../src/app/helper/system/system', () => ({
    system: { getBoolean: () => longPollingEnabled },
}))

const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
} as unknown as FastifyBaseLogger

const source: LongPollingSource = {
    key: `${QADAM_NAME}|project1|my-bot-connection`,
    triggerSourceId: 'ts1',
    qadamName: QADAM_NAME,
    projectId: 'project1',
    flowId: 'flow1',
    flowVersionId: 'fv1',
    connectionExternalId: 'my-bot-connection',
    config: { transport: 'long_polling' },
    enabledAt: '2026-01-01T00:00:00.000Z',
}

function puller(waitForEvents: QadamEventPuller['waitForEvents']): QadamEventPuller {
    return {
        windowSeconds: 1,
        isEnabledFor: () => true,
        credentialKey: () => CREDENTIAL_KEY,
        waitForEvents,
    }
}

/** The "this instance won the election" case: fn runs inline under a signal that never fires. */
function grantsTheLock() {
    return runExclusive.mockImplementation(({ fn }: LockParams) => fn(new AbortController().signal))
}

async function loadHost() {
    vi.resetModules()
    const module = await import('../../../../../src/app/trigger/long-polling/long-polling-host')
    return module.longPollingHost(mockLog)
}

// Namespaced by qadam as well, so two pullers with colliding credential keys cannot share it.
const cursorKey = `long-polling:cursor:${QADAM_NAME}|${CREDENTIAL_KEY}`
const stopsImmediately = { outcome: QadamEventPullOutcome.FATAL, reason: 'stop' }

describe('longPollingHost', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        store.clear()
        longPollingEnabled = true
        grantsTheLock()
        listSources.mockResolvedValue([source])
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: QADAM_NAME,
            value: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
        connectionExistsBy.mockResolvedValue(false)
        reportStatus.mockResolvedValue(undefined)
        clearStatus.mockResolvedValue(undefined)
        handleWebhook.mockResolvedValue({ status: StatusCodes.OK, body: {}, headers: {} })
    })

    it('does nothing at all while the feature flag is off', async () => {
        longPollingEnabled = false

        const host = await loadHost()
        await host.start()

        expect(listSources).not.toHaveBeenCalled()
    })

    it('delivers each pulled event and only then persists the cursor', async () => {
        const waitForEvents = vi.fn()
            .mockResolvedValueOnce({
                outcome: QadamEventPullOutcome.EVENTS,
                events: [{ update_id: 9 }, { update_id: 10 }],
                nextCursor: '11',
            })
            .mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(2))
        await host.stop()

        expect(handleWebhook).toHaveBeenCalledTimes(2)
        expect(await handleWebhook.mock.calls[0][0].data('project1')).toEqual({
            body: { update_id: 9 },
            rawBody: { update_id: 9 },
            method: 'POST',
            headers: {},
            queryParams: {},
        })
        expect(store.get(cursorKey)).toBe('11')
    })

    it('leaves the cursor where it was when delivery fails', async () => {
        store.set(cursorKey, '5')
        const waitForEvents = vi.fn()
            .mockResolvedValueOnce({
                outcome: QadamEventPullOutcome.EVENTS,
                events: [{ update_id: 9 }],
                nextCursor: '10',
            })
            .mockResolvedValue(stopsImmediately)
        handleWebhook.mockRejectedValue(new Error('queue is down'))
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledTimes(1))
        await host.stop()

        expect(store.get(cursorKey)).toBe('5')
    })

    it('keys the lock and the cursor on the credential, not on the connection', async () => {
        const waitForEvents = vi.fn().mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        await host.stop()

        expect(runExclusive.mock.calls[0][0].key).toBe(`long-polling:${QADAM_NAME}|${CREDENTIAL_KEY}`)
        expect(runExclusive.mock.calls[0][0].key).not.toContain(source.connectionExternalId)
    })

    it('passes the stored cursor back to the puller', async () => {
        store.set(cursorKey, '42')
        const waitForEvents = vi.fn().mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents.mock.calls[0][0]).toMatchObject({
            cursor: '42',
            config: { transport: 'long_polling' },
            auth: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
    })

    it('stops a fatal source and does not restart it on the next resync', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.FATAL,
            reason: 'webhook is still active',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        host.requestSync()
        await vi.waitFor(() => expect(listSources).toHaveBeenCalledTimes(2))
        await new Promise((resolve) => setTimeout(resolve, 20))
        await host.stop()

        expect(waitForEvents).toHaveBeenCalledTimes(1)
    })

    it('clears the fatal mark once the flow is disabled and enabled again', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({ outcome: QadamEventPullOutcome.FATAL, reason: 'gone' })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(1))

        // `triggerSourceService.enable` always writes a new row, even without a republish.
        listSources.mockResolvedValue([{ ...source, triggerSourceId: 'ts2' }])
        host.requestSync()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(2))
        await host.stop()
    })

    it('retries rather than giving up when the connection cannot be read right now', async () => {
        lockAndRefreshConnection.mockRejectedValueOnce(new Error('the database is failing over'))
        const waitForEvents = vi.fn().mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(1), { timeout: 3000 })
        await host.stop()

        expect(vi.mocked(mockLog.warn).mock.calls.some(([, message]) =>
            String(message).includes('Could not read the connection'))).toBe(true)
        // The point of the finding: a read failure must not be recorded as a missing connection.
        expect(vi.mocked(mockLog.error).mock.calls.some(([details]) =>
            String((details as { reason?: unknown }).reason).includes('connection'))).toBe(false)
    })

    // `lockAndRefreshConnection` catches its own database errors and returns null, so a null is not
    // proof of absence — this is the shape a Postgres failover actually takes.
    it('does not mistake an unreadable connection for a deleted one', async () => {
        lockAndRefreshConnection.mockResolvedValue(null)
        connectionExistsBy.mockResolvedValue(true)
        const waitForEvents = vi.fn().mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(vi.mocked(mockLog.warn)).toHaveBeenCalled())
        await host.stop()

        expect(vi.mocked(mockLog.error)).not.toHaveBeenCalled()
    })

    it('backs off rather than giving up when it cannot even confirm the connection is gone', async () => {
        lockAndRefreshConnection.mockResolvedValue(null)
        connectionExistsBy.mockRejectedValue(new Error('the database is failing over'))
        const waitForEvents = vi.fn().mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(vi.mocked(mockLog.warn)).toHaveBeenCalled())
        await host.stop()

        expect(vi.mocked(mockLog.error)).not.toHaveBeenCalled()
    })

    it('treats a deleted connection as fatal rather than polling without credentials', async () => {
        lockAndRefreshConnection.mockResolvedValue(null)
        const waitForEvents = vi.fn()
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents).not.toHaveBeenCalled()
    })

    it('refuses to hand a puller another qadam\'s connection', async () => {
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: '@aiqadam/qadam-slack',
            value: { type: 'SECRET_TEXT', secret_text: 'xoxb-not-yours' },
        })
        const waitForEvents = vi.fn()
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents).not.toHaveBeenCalled()
    })

    it('re-queues for the lock instead of giving the source up when another instance holds it', async () => {
        runExclusive.mockRejectedValue(new Error('lock is held elsewhere'))
        const waitForEvents = vi.fn()
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents).not.toHaveBeenCalled()
        // Still the instance's task: it is waiting for the lock, not marked fatal.
        expect(mockLog.warn).toHaveBeenCalled()
    })

    it('goes back for the lock when it loses it mid-window, instead of stopping', async () => {
        const lockLost = new AbortController()
        const waitForEvents = vi.fn().mockImplementation(async () => {
            lockLost.abort()
            return { outcome: QadamEventPullOutcome.EVENTS, events: [], nextCursor: '1' }
        })
        getPuller.mockReturnValue(puller(waitForEvents))
        runExclusive.mockImplementationOnce(({ fn }: LockParams) => fn(lockLost.signal))

        const { longPollingTiming } = await import('../../../../../src/app/trigger/long-polling/long-polling-host')
        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1))
        // The re-queue waits out LOCK_RETRY_DELAY_MS, so without advancing time a task that gave up
        // and one that is waiting look identical — which is what made the earlier version of this
        // test unable to fail.
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            await vi.advanceTimersByTimeAsync(longPollingTiming.LOCK_RETRY_DELAY_MS + 100)
            await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(2))
        }
        finally {
            vi.useRealTimers()
        }
        await host.stop()
    })

    // If this branch is ever dropped, the loop polls the new bot while holding the old bot's lock,
    // so another instance can take the new bot's lock — two consumers on one token, which is the
    // exact failure the credential-keyed lock exists to prevent.
    it('re-acquires under the new key when the connection is retargeted at another bot', async () => {
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: QADAM_NAME,
            value: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
        // The first window runs under the key the lock was taken with; the connection is retargeted
        // while it is open, so the re-resolve at the end of that window sees a different bot.
        const credentialKey = vi.fn().mockReturnValueOnce('bot-777').mockReturnValue('bot-888')
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })
        getPuller.mockReturnValue({ ...puller(waitForEvents), credentialKey })

        const { longPollingTiming } = await import('../../../../../src/app/trigger/long-polling/long-polling-host')
        const host = await loadHost()
        // Fake timers from the start, so both the pacing floor and the lock-retry delay are
        // advanceable — a timer created before they are installed cannot be.
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            await host.start()
            await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1))
            await vi.advanceTimersByTimeAsync(longPollingTiming.MIN_WINDOW_INTERVAL_MS + longPollingTiming.LOCK_RETRY_DELAY_MS + 200)
            await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(2))
        }
        finally {
            vi.useRealTimers()
        }
        await host.stop()

        const keys = runExclusive.mock.calls.map(([params]) => params.key)
        expect(keys[0]).toContain('bot-777')
        expect(keys[1]).toContain('bot-888')
        // One window per grant: the loop stopped as soon as the key moved instead of carrying on
        // against the new bot while still holding the old bot's lock.
        expect(waitForEvents).toHaveBeenCalledTimes(2)
    })

    // The stored status carries a TTL, so reporting POLLING on every window is what distinguishes
    // "a host is working on this" from "a host died holding it". An earlier version of this commit
    // silently never reported POLLING at all, which inverted the whole feature: a STOPPED status
    // expired after five minutes and a permanently dead bot rendered as healthy again.
    it('reports that it is polling on every window, not only when something goes wrong', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(2), { timeout: 3000 })
        await host.stop()

        const polling = reportStatus.mock.calls
            .map(([params]) => params)
            .filter((params) => params.status === 'POLLING')
        expect(polling.length).toBeGreaterThanOrEqual(2)
        expect(polling[0]).toMatchObject({ projectId: source.projectId, flowId: source.flowId })
    })

    it('keeps republishing a stopped source, so its status cannot quietly expire', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.FATAL,
            reason: 'the token was revoked',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'STOPPED' })))
        const afterFirst = reportStatus.mock.calls.filter(([params]) => params.status === 'STOPPED').length
        host.requestSync()
        await vi.waitFor(() => expect(
            reportStatus.mock.calls.filter(([params]) => params.status === 'STOPPED').length,
        ).toBeGreaterThan(afterFirst))
        await host.stop()

        // And it is still only the one task: republishing must not restart a fatal source.
        expect(waitForEvents).toHaveBeenCalledTimes(1)
    })

    it('does not put raw infrastructure error text where a user will read it', async () => {
        // The first resolve succeeds so the lock is taken; the re-resolve inside the window fails.
        // Only the in-lock path reports, since a follower must not overwrite the leader's status.
        lockAndRefreshConnection
            .mockResolvedValueOnce({
                status: AppConnectionStatus.ACTIVE,
                qadamName: QADAM_NAME,
                value: { type: 'SECRET_TEXT', secret_text: '777:token' },
            })
            .mockRejectedValue(new Error('connect ECONNREFUSED 10.42.1.7:6379'))
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
            status: 'BACKING_OFF',
        })))
        await host.stop()

        const reasons = reportStatus.mock.calls.map(([params]) => params.reason ?? '')
        expect(reasons.some((reason) => reason.includes('10.42.1.7'))).toBe(false)
        expect(reasons.some((reason) => reason.includes('ECONNREFUSED'))).toBe(false)
    })

    // A published, switched-on flow that receives nothing looks identical to a healthy one in the
    // UI, so the reason has to reach somewhere a user can read it.
    it('publishes why it stopped, not just that it stopped', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.FATAL,
            reason: 'the webhook is still registered for this bot',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
            status: 'STOPPED',
        })))
        await host.stop()

        const stopped = reportStatus.mock.calls.map(([params]) => params).find((params) => params.status === 'STOPPED')
        expect(stopped).toMatchObject({
            projectId: source.projectId,
            flowId: source.flowId,
            reason: 'the webhook is still registered for this bot',
        })
    })

    it('reports a retryable failure as backing off rather than as stopped', async () => {
        const waitForEvents = vi.fn()
            .mockResolvedValueOnce({ outcome: QadamEventPullOutcome.RETRYABLE, reason: 'telegram is down' })
            .mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
            status: 'BACKING_OFF',
            reason: 'telegram is down',
        })))
        await host.stop()
    })

    it('clears the status of a source it stops serving, instead of leaving it to expire', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        listSources.mockResolvedValue([])
        host.requestSync()
        await vi.waitFor(() => expect(clearStatus).toHaveBeenCalledWith({
            projectId: source.projectId,
            flowId: source.flowId,
        }))
        await host.stop()
    })

    // Contained by the host's own wrapper, and backed off rather than stopped: a throw is local to
    // this instance, and `fatalSources` is republished without the lock, so a permanent verdict here
    // would let one unhealthy instance contradict the leader that is polling the same bot fine.
    it('backs a throwing puller off instead of taking anything else down', async () => {
        const waitForEvents = vi.fn().mockRejectedValue(new Error('qadam blew up'))
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await expect(host.start()).resolves.toBeUndefined()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
            status: 'BACKING_OFF',
        })))
        await host.stop()

        expect(reportStatus.mock.calls.some(([params]) => params.status === 'STOPPED')).toBe(false)
        expect(vi.mocked(mockLog.error)).not.toHaveBeenCalled()
    })

    it('stops a puller that returns a result it does not understand', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({ outcome: 'SOMETHING_ELSE' })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents).toHaveBeenCalledTimes(1)
    })

    it('leaves no task polling after shutdown, even one spawned by a reconciliation in flight', async () => {
        let releaseList = (): void => undefined
        listSources.mockImplementation(() => new Promise((resolve) => {
            releaseList = () => resolve([source])
        }))
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        const starting = host.start()
        await vi.waitFor(() => expect(listSources).toHaveBeenCalled())
        const stopping = host.stop()
        releaseList()
        await starting
        const stoppedAt = Date.now()
        await stopping
        // Shutdown must not have to wait out its own grace period: the task has to actually stop.
        expect(Date.now() - stoppedAt).toBeLessThan(1000)

        const callsAtShutdown = waitForEvents.mock.calls.length
        // Longer than MIN_WINDOW_INTERVAL_MS: an orphaned task sleeps out the pacing floor between
        // windows, so a shorter wait than that cannot see it still running.
        await new Promise((resolve) => setTimeout(resolve, 900))
        expect(waitForEvents.mock.calls.length).toBe(callsAtShutdown)
    })

    describe('assertTransportIsAvailable', () => {
        it('refuses a long-polling trigger while the host is switched off', async () => {
            longPollingEnabled = false
            getPuller.mockReturnValue(puller(vi.fn()))

            const host = await loadHost()

            await expect(host.assertTransportIsAvailable({
                qadamName: QADAM_NAME,
                config: { transport: 'long_polling' },
            })).rejects.toThrow(/AP_TRIGGER_LONG_POLLING_ENABLED/)
        })

        it('allows a webhook trigger of the same qadam while the host is switched off', async () => {
            longPollingEnabled = false
            getPuller.mockReturnValue({ ...puller(vi.fn()), isEnabledFor: () => false })

            const host = await loadHost()

            await expect(host.assertTransportIsAvailable({
                qadamName: QADAM_NAME,
                config: { transport: 'webhook' },
            })).resolves.toBeUndefined()
        })

        it('never loads a qadam that has no puller registered', async () => {
            longPollingEnabled = false

            const host = await loadHost()
            await host.assertTransportIsAvailable({ qadamName: '@aiqadam/qadam-slack', config: {} })

            expect(getPuller).not.toHaveBeenCalled()
        })
    })
})

type LockParams = {
    key: string
    timeoutInSeconds: number
    fn: (signal: AbortSignal) => Promise<unknown>
}

describe('longPollingHost window pacing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        store.clear()
        longPollingEnabled = true
        grantsTheLock()
        listSources.mockResolvedValue([source])
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: QADAM_NAME,
            value: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
        connectionExistsBy.mockResolvedValue(false)
        handleWebhook.mockResolvedValue({ status: StatusCodes.OK, body: {}, headers: {} })
    })

    // A puller that returns instantly — a misconfigured endpoint answering with an empty batch —
    // must not be able to spin the loop at full speed inside the process serving user requests.
    it('paces a puller that returns immediately instead of spinning on it', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await new Promise((resolve) => setTimeout(resolve, 600))
        await host.stop()

        expect(waitForEvents.mock.calls.length).toBeGreaterThan(0)
        expect(waitForEvents.mock.calls.length).toBeLessThan(10)
    })
})
