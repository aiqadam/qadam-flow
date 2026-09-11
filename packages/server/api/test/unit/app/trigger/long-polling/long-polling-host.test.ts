import { QadamEventPuller, QadamEventPullOutcome } from '@aiqadam/qadams-framework'
import { AppConnectionStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { longPollingCapacity } from '../../../../../src/app/trigger/long-polling/long-polling-capacity'
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
const reportStatusIfAbsent = vi.fn()
const clearStatus = vi.fn()
const store = new Map<string, unknown>()
let longPollingEnabled: boolean | undefined = true

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
    // Both members, or a missing one reads as `undefined` at the call site and an assertion on it
    // passes against nothing.
    WebhookFlowVersionToRun: { LOCKED_FALL_BACK_TO_LATEST: 'locked_fall_back_to_latest', LATEST: 'latest' },
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
        reportIfAbsent: (...args: unknown[]) => reportStatusIfAbsent(...args),
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
        listSources.mockResolvedValue({ sources: [source], starved: [], ambiguous: [] })
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: QADAM_NAME,
            value: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
        connectionExistsBy.mockResolvedValue(false)
        reportStatus.mockResolvedValue(undefined)
        reportStatusIfAbsent.mockResolvedValue(undefined)
        clearStatus.mockResolvedValue(undefined)
        handleWebhook.mockResolvedValue({ status: StatusCodes.OK, body: {}, headers: {} })
    })

    it('does nothing at all when an operator switches it off', async () => {
        longPollingEnabled = false

        const host = await loadHost()
        await host.start()

        expect(listSources).not.toHaveBeenCalled()
    })

    // Nothing to opt into: the cost of an unused install is paid by the registry query stopping at
    // zero rows, not by an operator remembering to set a variable.
    it('runs by default, with nothing configured', async () => {
        longPollingEnabled = undefined

        const host = await loadHost()
        await host.start()
        await host.stop()

        expect(listSources).toHaveBeenCalled()
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
        listSources.mockResolvedValue({ sources: [{ ...source, triggerSourceId: 'ts2' }], starved: [], ambiguous: [] })
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

    // Telegram can ask for a 30-minute delay. If the entry expires inside that sleep the warning
    // vanishes mid-outage and the flow reads as healthy again.
    it('gives a backing-off status a life at least as long as the wait it announces', async () => {
        const waitForEvents = vi.fn()
            .mockResolvedValueOnce({
                outcome: QadamEventPullOutcome.RETRYABLE,
                reason: 'flood control',
                retryAfterSeconds: 1800,
            })
            .mockResolvedValue(stopsImmediately)
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatus).toHaveBeenCalledWith(expect.objectContaining({
            status: 'BACKING_OFF',
        })))
        await host.stop()

        const backingOff = reportStatus.mock.calls
            .map(([params]) => params)
            .find((params) => params.status === 'BACKING_OFF')
        expect(backingOff.ttlSeconds).toBeGreaterThanOrEqual(1800)
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

    // The webhook endpoint refuses pushed deliveries for these, so a flow missing from the set
    // stays open to forgeries and one wrongly in it stops receiving anything at all.
    it('tells the webhook endpoint which flows it serves, including the starved ones', async () => {
        const starved = { ...source, key: 'other', triggerSourceId: 'ts9', flowId: 'starved-flow' }
        listSources.mockResolvedValue({ sources: [source], starved: [starved], ambiguous: [] })
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue(stopsImmediately)))

        const host = await loadHost()
        const { longPollingServed } = await import('../../../../../src/app/trigger/long-polling/long-polling-served')
        await host.start()
        await vi.waitFor(() => expect(listSources).toHaveBeenCalled())

        expect(longPollingServed.isServedByPulling(source.flowId)).toBe(true)
        expect(longPollingServed.isServedByPulling('starved-flow')).toBe(true)
        expect(longPollingServed.isServedByPulling('some-other-flow')).toBe(false)

        await host.stop()
        // Nothing is polling after shutdown, so pushed delivery must work again.
        expect(longPollingServed.isServedByPulling(source.flowId)).toBe(false)
    })

    // Observed live when switching a connection from pulling to webhook: `sync` cleared the status,
    // and the task it had just aborted then reported its own abort as a retryable failure — leaving
    // a warning standing on a flow that was by then healthy on the other transport.
    it('does not report the abort that stood it down', async () => {
        const waitForEvents = vi.fn().mockImplementation(async ({ signal }) => {
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
            return { outcome: QadamEventPullOutcome.RETRYABLE, reason: 'This operation was aborted' }
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalled())
        reportStatus.mockClear()
        await host.stop()
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(reportStatus.mock.calls.some(([params]) => params.status === 'BACKING_OFF')).toBe(false)
    })

    // An ambiguous source's delivery mode was never determined, so its webhook may well be live.
    // Refusing it would take a working flow off the air — which is what merging these two lists into
    // one did, and the reason they are separate.
    it('reports an ambiguous source but leaves its webhook working', async () => {
        const ambiguous = { ...source, key: 'ambiguous', triggerSourceId: 'ts-ambiguous', flowId: 'flow-ambiguous' }
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))
        listSources.mockResolvedValue({ sources: [source], starved: [], ambiguous: [ambiguous] })

        const host = await loadHost()
        const { longPollingServed } = await import('../../../../../src/app/trigger/long-polling/long-polling-served')
        await host.start()
        await vi.waitFor(() => expect(longPollingServed.isServedByPulling(source.flowId)).toBe(true))

        expect(longPollingServed.isServedByPulling('flow-ambiguous')).toBe(false)
        await vi.waitFor(() => expect(reportStatus.mock.calls.some(([params]) =>
            params.flowId === 'flow-ambiguous' && params.status === 'STOPPED')).toBe(true))
        // And not with the starved flow's reason, which names a cause that is not this one.
        const reported = reportStatus.mock.calls.find(([params]) => params.flowId === 'flow-ambiguous')?.[0]
        expect(reported.reason).toMatch(/share an id/)
        await host.stop()
    })

    // On a republish the key is re-created in the same pass and the successor owns the status, so a
    // deferred clear would wipe the live entry the successor just wrote.
    it('does not clear the status when the source is replaced rather than removed', async () => {
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        clearStatus.mockClear()
        listSources.mockResolvedValue({ sources: [{ ...source, triggerSourceId: 'ts-republished' }], starved: [], ambiguous: [] })
        host.requestSync()

        await vi.waitFor(() => expect(listSources).toHaveBeenCalledTimes(2))
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(clearStatus).not.toHaveBeenCalledWith({ projectId: source.projectId, flowId: source.flowId })
        await host.stop()
    })

    // The status a sync has just written and the clear the same sync defers onto the dying task
    // collide by construction: a flow that has just become starved or ambiguous is usually exactly
    // one whose task is going away, and the clear lands later, so it wins. The user would see the
    // explanation appear and vanish.
    it('does not clear a status this same sync has just written', async () => {
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        clearStatus.mockClear()
        reportStatus.mockClear()
        // The task goes away and the flow becomes ambiguous in the same pass.
        listSources.mockResolvedValue({ sources: [], starved: [], ambiguous: [source] })
        host.requestSync()

        await vi.waitFor(() => expect(reportStatus.mock.calls.some(([params]) =>
            params.flowId === source.flowId && params.status === 'STOPPED')).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(clearStatus).not.toHaveBeenCalledWith({ projectId: source.projectId, flowId: source.flowId })
        await host.stop()
    })

    // Each task holds an HTTP request open for its whole window, so the ceiling is a resource bound.
    // A refused flow must say so: it is enabled, published and receiving nothing.
    it('refuses to start more tasks than its share, and reports the ones it refused', async () => {
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))
        const share = longPollingCapacity.shareFor({ projectsWanting: 1 })
        const tooMany = Array.from({ length: share + 3 }, (_, index) => ({
            ...source,
            key: `key${index}`,
            triggerSourceId: `ts${index}`,
            flowId: `flow${index}`,
            connectionExternalId: `connection${index}`,
        }))
        listSources.mockResolvedValue({ sources: tooMany, starved: [], ambiguous: [] })

        const host = await loadHost()
        await host.start()

        await vi.waitFor(() => expect(reportStatus.mock.calls.some(([params]) =>
            params.status === 'STOPPED' && /polling connection/.test(params.reason ?? ''))).toBe(true))
        const refused = reportStatus.mock.calls.filter(([params]) => /polling connection/.test(params.reason ?? ''))
        expect(refused.length).toBe(3)
        // And the ones within the share really are running.
        expect(runExclusive.mock.calls.length).toBe(share)
        await host.stop()
    }, 30_000)

    // The per-project share is the fairness knob; this is the resource bound underneath it, and the
    // one the module exists to enforce — each task holds a socket open for its whole window. Nine
    // projects put the share on its floor, so eight of them fill the instance and the ninth meets
    // the global ceiling rather than its own share.
    it('refuses past the instance ceiling, not only past a project share', async () => {
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))
        const projectsWanting = 9
        const share = longPollingCapacity.shareFor({ projectsWanting })
        const perProject = Array.from({ length: projectsWanting }, (_, project) =>
            Array.from({ length: share }, (_, index) => ({
                ...source,
                key: `p${project}-k${index}`,
                triggerSourceId: `p${project}-ts${index}`,
                flowId: `p${project}-flow${index}`,
                projectId: `project${project}`,
                connectionExternalId: `p${project}-connection${index}`,
            })))
        listSources.mockResolvedValue({ sources: perProject.flat(), starved: [], ambiguous: [] })

        const host = await loadHost()
        await host.start()

        await vi.waitFor(() => expect(runExclusive.mock.calls.length).toBe(longPollingCapacity.MAX_CONCURRENT_TASKS))
        // The last project is inside its own share and still refused: the instance is full.
        const refusedFlows = reportStatus.mock.calls
            .filter(([params]) => /polling connection/.test(params.reason ?? ''))
            .map(([params]) => params.flowId)
        expect(refusedFlows.length).toBe(projectsWanting * share - longPollingCapacity.MAX_CONCURRENT_TASKS)
        // The ones refused are the last project's, and they are inside its own share — so this is
        // the instance ceiling talking, not the per-project one.
        expect(refusedFlows.every((flowId: string) => flowId.startsWith(`p${projectsWanting - 1}-`))).toBe(true)
        await host.stop()
    }, 30_000)

    // The guard's comment argues this case explicitly: a flow that just lost its connection to
    // another flow is usually one whose task is going away — usually, not always, since a flow that
    // loses on its very first sync never had a task. It is the half most likely to regress, and it
    // was the untested one.
    it('does not clear a starved flow\'s status either', async () => {
        getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [],
            nextCursor: '1',
        })))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalled())
        clearStatus.mockClear()
        reportStatus.mockClear()
        listSources.mockResolvedValue({ sources: [], starved: [source], ambiguous: [] })
        host.requestSync()

        await vi.waitFor(() => expect(reportStatus.mock.calls.some(([params]) =>
            params.flowId === source.flowId && params.status === 'STOPPED')).toBe(true))
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(clearStatus).not.toHaveBeenCalledWith({ projectId: source.projectId, flowId: source.flowId })
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
        listSources.mockResolvedValue({ sources: [], starved: [], ambiguous: [] })
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
    // Removing the pre-lock report fixed a follower overwriting the leader — but a credential that
    // is unreadable on *every* instance never reaches the lock, so without a yielding write it
    // would publish nothing at all and the flow would read as healthy while receiving nothing.
    it('still says something when no instance can read the credential at all', async () => {
        lockAndRefreshConnection.mockRejectedValue(new Error('the database is failing over'))
        getPuller.mockReturnValue(puller(vi.fn()))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(reportStatusIfAbsent).toHaveBeenCalledWith(expect.objectContaining({
            status: 'BACKING_OFF',
        })))
        await host.stop()

        // Yielding, not overwriting: the leader's POLLING must win if there is a leader.
        expect(reportStatus).not.toHaveBeenCalled()
    })

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
            releaseList = () => resolve({ sources: [source], starved: [], ambiguous: [] })
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

    describe('simulation sources', () => {
        const simulated = { ...source, simulate: true, flowId: 'flow-sim' }

        beforeEach(() => {
            getPuller.mockReturnValue(puller(vi.fn().mockResolvedValue({
                outcome: QadamEventPullOutcome.EVENTS,
                events: [{ update_id: 1 }],
                nextCursor: '1',
            })))
            listSources.mockResolvedValue({ sources: [simulated], starved: [], ambiguous: [] })
        })

        // A test collects sample data for the draft the user is editing. Running anything would be
        // wrong in both directions: the published version is not what is being tested, and the
        // draft is unpublished — its actions would fire on real messages while the panel is open.
        // The pushed transport's simulation goes to `/test`, which passes `execute: false`.
        it('delivers to the draft, collecting sample data without running a flow', async () => {
            const host = await loadHost()
            await host.start()

            await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalled())
            expect(handleWebhook.mock.calls[0][0]).toMatchObject({
                flowId: 'flow-sim',
                saveSampleData: true,
                flowVersionToRun: 'latest',
                execute: false,
            })
            await host.stop()
        })

        // The served set makes the webhook endpoint answer 409. A simulation says nothing about the
        // production transport — the flow being tested may be a webhook flow — so refusing its
        // deliveries would take a working flow off the air while the builder panel is open.
        it('does not put the flow being tested into the pull-served set', async () => {
            const host = await loadHost()
            const { longPollingServed } = await import('../../../../../src/app/trigger/long-polling/long-polling-served')
            await host.start()

            await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalled())
            expect(longPollingServed.isServedByPulling('flow-sim')).toBe(false)
            await host.stop()
        })

        // Status is keyed on the flow, which a simulation shares with the production delivery. Its
        // reports would overwrite the one the user is asking about, then expire — leaving a healthy
        // flow looking stopped.
        it('reports no status of its own', async () => {
            const host = await loadHost()
            await host.start()

            await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalled())
            expect(reportStatus.mock.calls.filter(([params]) => params.flowId === 'flow-sim')).toEqual([])
            await host.stop()
        })
    })

    describe('assertTransportIsAvailable', () => {
        it('refuses a long-polling trigger while the host is switched off', async () => {
            longPollingEnabled = false
            getPuller.mockReturnValue(puller(vi.fn()))

            const host = await loadHost()

            await expect(host.assertTransportIsAvailable({
                qadamName: QADAM_NAME,
                readConnectionMetadata: async () => ({ transport: 'long_polling' }),
            })).rejects.toThrow(/AP_TRIGGER_LONG_POLLING_ENABLED/)
        })

        it('allows a webhook trigger of the same qadam while the host is switched off', async () => {
            longPollingEnabled = false
            getPuller.mockReturnValue({ ...puller(vi.fn()), isEnabledFor: () => false })

            const host = await loadHost()

            await expect(host.assertTransportIsAvailable({
                qadamName: QADAM_NAME,
                readConnectionMetadata: async () => ({ transport: 'webhook' }),
            })).resolves.toBeUndefined()
        })

        it('never loads a qadam that has no puller registered', async () => {
            longPollingEnabled = false

            const host = await loadHost()
            const readConnectionMetadata = vi.fn(async () => ({}))
            await host.assertTransportIsAvailable({ qadamName: '@aiqadam/qadam-slack', readConnectionMetadata })

            expect(getPuller).not.toHaveBeenCalled()
            // The read costs a query, on a path every publish and every flow enable goes through.
            expect(readConnectionMetadata).not.toHaveBeenCalled()
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
        listSources.mockResolvedValue({ sources: [source], starved: [], ambiguous: [] })
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            qadamName: QADAM_NAME,
            value: { type: 'SECRET_TEXT', secret_text: '777:token' },
        })
        connectionExistsBy.mockResolvedValue(false)
        handleWebhook.mockResolvedValue({ status: StatusCodes.OK, body: {}, headers: {} })
    })

    // Measured on a live bot: `getUpdates` returns on the first event, so a burst of 13 messages
    // arrives as 13 separate windows. Pacing those would cap throughput at ~4 messages a second,
    // which is what the first version of this floor did.
    it('does not throttle a window that actually delivered something', async () => {
        const waitForEvents = vi.fn().mockResolvedValue({
            outcome: QadamEventPullOutcome.EVENTS,
            events: [{ update_id: 1 }],
            nextCursor: '2',
        })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await new Promise((resolve) => setTimeout(resolve, 600))
        await host.stop()

        // Well past the ~2 windows the 250ms floor would have allowed in 600ms.
        expect(waitForEvents.mock.calls.length).toBeGreaterThan(10)
    })

    // A puller that returns instantly *and empty* — a misconfigured endpoint, say — must not be
    // able to spin the loop at full speed inside the process serving user requests.
    it('paces a puller that returns immediately and empty, instead of spinning on it', async () => {
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
