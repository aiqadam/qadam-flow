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

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({ runExclusive: (params: LockParams) => runExclusive(params) }),
    distributedStore: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: unknown) => {
            store.set(key, value)
        },
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

const cursorKey = `long-polling:cursor:${CREDENTIAL_KEY}`
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
        expect(store.has(cursorKey)).toBe(false)
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

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1))
        await host.stop()

        // The first grant ended without the host signal firing, so the task must not consider
        // itself done — `pollUntilDone` returning `false` is what sends it back to the lock.
        expect(waitForEvents).toHaveBeenCalledTimes(1)
    })

    it('never lets a throwing puller take anything else down', async () => {
        const waitForEvents = vi.fn().mockRejectedValue(new Error('qadam blew up'))
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        await host.stop()

        // Marked fatal by the host's own wrapper — not merely swallowed further up the stack.
        expect(vi.mocked(mockLog.error).mock.calls.some(([, message]) =>
            String(message).includes('markFatal'))).toBe(true)
        expect(waitForEvents).toHaveBeenCalledTimes(1)
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
        await new Promise((resolve) => setTimeout(resolve, 50))
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
