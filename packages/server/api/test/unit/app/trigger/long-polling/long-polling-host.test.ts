import { QadamEventPuller, QadamEventPullOutcome } from '@aiqadam/qadams-framework'
import { AppConnectionStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LongPollingSource } from '../../../../../src/app/trigger/long-polling/long-polling-source'

const QADAM_NAME = '@aiqadam/qadam-telegram-bot'

const listSources = vi.fn()
const handleWebhook = vi.fn()
const lockAndRefreshConnection = vi.fn()
const getPuller = vi.fn()
const store = new Map<string, unknown>()
let longPollingEnabled = true

vi.mock('../../../../../src/app/trigger/long-polling/long-polling-source', () => ({
    longPollingSourceRegistry: () => ({ list: listSources }),
}))

vi.mock('../../../../../src/app/trigger/long-polling/event-puller-registry', () => ({
    eventPullerRegistry: {
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
    // The loop is the only holder in these tests, so running fn inline with a signal that never
    // fires is exactly the "this instance won the election" case.
    distributedLock: () => ({
        runExclusive: async ({ fn }: { fn: (signal: AbortSignal) => Promise<unknown> }) => fn(new AbortController().signal),
    }),
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
    key: `${QADAM_NAME}|project1|telegram`,
    qadamName: QADAM_NAME,
    projectId: 'project1',
    flowId: 'flow1',
    flowVersionId: 'fv1',
    connectionExternalId: 'telegram',
    config: { transport: 'long_polling' },
    enabledAt: '2026-01-01T00:00:00.000Z',
}

function puller(waitForEvents: QadamEventPuller['waitForEvents']): QadamEventPuller {
    return {
        windowSeconds: 1,
        isEnabledFor: () => true,
        waitForEvents,
    }
}

async function loadHost() {
    vi.resetModules()
    const module = await import('../../../../../src/app/trigger/long-polling/long-polling-host')
    return module.longPollingHost(mockLog)
}

const cursorKey = `long-polling:cursor:${source.key}`

describe('longPollingHost', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        store.clear()
        longPollingEnabled = true
        listSources.mockResolvedValue([source])
        lockAndRefreshConnection.mockResolvedValue({
            status: AppConnectionStatus.ACTIVE,
            value: { type: 'SECRET_TEXT', secret_text: 'token' },
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
            .mockResolvedValue({ outcome: QadamEventPullOutcome.FATAL, reason: 'stop' })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(2))
        await host.stop()

        expect(handleWebhook).toHaveBeenCalledTimes(2)
        const [firstCall] = handleWebhook.mock.calls
        expect(await firstCall[0].data('project1')).toEqual({
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
            .mockResolvedValue({ outcome: QadamEventPullOutcome.FATAL, reason: 'stop' })
        handleWebhook.mockRejectedValue(new Error('queue is down'))
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledTimes(1))
        await host.stop()

        expect(store.get(cursorKey)).toBe('5')
    })

    it('passes the stored cursor back to the puller', async () => {
        store.set(cursorKey, '42')
        const waitForEvents = vi.fn().mockResolvedValue({ outcome: QadamEventPullOutcome.FATAL, reason: 'stop' })
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents.mock.calls[0][0]).toMatchObject({
            cursor: '42',
            config: { transport: 'long_polling' },
            auth: { type: 'SECRET_TEXT', secret_text: 'token' },
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
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(1))
        host.requestSync()
        await vi.waitFor(() => expect(listSources).toHaveBeenCalledTimes(2))
        await host.stop()

        expect(waitForEvents).toHaveBeenCalledTimes(1)
        expect(mockLog.error).toHaveBeenCalled()
    })

    it('treats a missing connection as fatal rather than polling without credentials', async () => {
        lockAndRefreshConnection.mockResolvedValue(null)
        const waitForEvents = vi.fn()
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await host.start()
        await vi.waitFor(() => expect(mockLog.error).toHaveBeenCalled())
        await host.stop()

        expect(waitForEvents).not.toHaveBeenCalled()
    })

    it('never lets a throwing puller escape its own task', async () => {
        const waitForEvents = vi.fn().mockRejectedValue(new Error('qadam blew up'))
        getPuller.mockReturnValue(puller(waitForEvents))

        const host = await loadHost()
        await expect(host.start()).resolves.toBeUndefined()
        await vi.waitFor(() => expect(waitForEvents).toHaveBeenCalledTimes(1))
        await host.stop()

        expect(waitForEvents).toHaveBeenCalledTimes(1)
    })
})
