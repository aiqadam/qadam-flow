import { PopulatedRecord, TableWebhookEventType, UpsertAction } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
// Every table in the CE integration suite has zero webhooks, so nothing there ever
// reached past the early return — the pacing, the single lookup and the allSettled
// handling were all unexecuted by any test.
import { recordSideEffects } from '../../../../src/app/tables/record/record-side-effects'
import { splitByUpsertOutcome } from '../../../../src/app/tables/record/record.controller'

const getWebhooks = vi.fn()
const triggerWebhooks = vi.fn()

vi.mock('../../../../src/app/tables/table/table.service', () => ({
    tableService: { getWebhooks: (...args: unknown[]) => getWebhooks(...args) },
}))
vi.mock('../../../../src/app/tables/record/record.service', () => ({
    recordService: { triggerWebhooks: (...args: unknown[]) => triggerWebhooks(...args) },
}))



const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

function record(id: string): PopulatedRecord {
    return { id, created: '', updated: '', tableId: 'table_1', projectId: 'project_1', cells: {} }
}

function handle(records: PopulatedRecord[]) {
    return recordSideEffects(logger).handleRecordsEvent({
        projectId: 'project_1',
        tableId: 'table_1',
        records,
        logger,
        authorization: 'Bearer token',
    }, 'updated')
}

describe('recordSideEffects.handleRecordsEvent', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getWebhooks.mockResolvedValue([{ id: 'webhook_1', flowId: 'flow_1' }])
        triggerWebhooks.mockResolvedValue(undefined)
    })

    it('looks the webhooks up once for the whole batch, not once per record', async () => {
        await handle([record('a'), record('b'), record('c')])

        expect(getWebhooks).toHaveBeenCalledTimes(1)
        expect(getWebhooks).toHaveBeenCalledWith({ projectId: 'project_1', id: 'table_1', events: [TableWebhookEventType.RECORD_UPDATED] })
        expect(triggerWebhooks).toHaveBeenCalledTimes(3)
    })

    it('hands the prefetched list to every dispatch, so none of them queries again', async () => {
        await handle([record('a'), record('b')])

        for (const call of triggerWebhooks.mock.calls) {
            expect(call[0].webhooks).toEqual([{ id: 'webhook_1', flowId: 'flow_1' }])
            expect(call[0].authorization).toBe('Bearer token')
        }
        expect(triggerWebhooks.mock.calls.map((call) => call[0].data)).toEqual([{ record: record('a') }, { record: record('b') }])
    })

    it('costs one query and no dispatch when the table has no webhooks', async () => {
        getWebhooks.mockResolvedValue([])

        await handle([record('a'), record('b'), record('c')])

        expect(getWebhooks).toHaveBeenCalledTimes(1)
        expect(triggerWebhooks).not.toHaveBeenCalled()
    })

    it('does not query at all for an empty batch', async () => {
        await handle([])

        expect(getWebhooks).not.toHaveBeenCalled()
    })

    // This runs after reply.send(), so a rejection has nowhere to surface except the
    // log — and under Promise.all it took the whole aggregate with it.
    it('settles every dispatch even when one rejects, and records that it failed', async () => {
        triggerWebhooks.mockRejectedValueOnce(new Error('queue unavailable'))

        await expect(handle([record('a'), record('b'), record('c')])).resolves.toBeUndefined()

        expect(triggerWebhooks).toHaveBeenCalledTimes(3)
        expect(logger.error).toHaveBeenCalledTimes(1)
        const [payload] = vi.mocked(logger.error).mock.calls[0]
        expect(payload).toMatchObject({ failed: 1, total: 3 })
    })

    it.each([
        ['created', TableWebhookEventType.RECORD_CREATED],
        ['updated', TableWebhookEventType.RECORD_UPDATED],
    ] as const)('fires the %s event for the rows that outcome describes', async (eventKey, expected) => {
        await recordSideEffects(logger).handleRecordsEvent({
            projectId: 'project_1',
            tableId: 'table_1',
            records: [record('a')],
            logger,
            authorization: 'Bearer token',
        }, eventKey)

        expect(getWebhooks).toHaveBeenCalledWith(expect.objectContaining({ events: [expected] }))
        expect(triggerWebhooks.mock.calls[0][0].eventType).toBe(expected)
    })

    it('paces the dispatches instead of releasing the whole batch at once', async () => {
        let inFlight = 0
        let peak = 0
        triggerWebhooks.mockImplementation(async () => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 1))
            inFlight -= 1
        })

        await handle(Array.from({ length: 40 }, (_, index) => record(`r${index}`)))

        expect(triggerWebhooks).toHaveBeenCalledTimes(40)
        expect(peak).toBeLessThanOrEqual(10)
    })
})

describe('splitByUpsertOutcome', () => {
    const created = { action: UpsertAction.CREATED, record: record('new') }
    const updated = { action: UpsertAction.UPDATED, record: record('existing') }

    // Inverting the predicate would fire RECORD_CREATED for rows that already existed,
    // re-running every "New Record" flow on a repeat delivery.
    it('routes each row to the event its outcome describes', () => {
        expect(splitByUpsertOutcome([updated, created])).toEqual([
            [[record('new')], 'created'],
            [[record('existing')], 'updated'],
        ])
    })

    it('still emits both buckets when one is empty, so neither event is skipped', () => {
        expect(splitByUpsertOutcome([created])).toEqual([
            [[record('new')], 'created'],
            [[], 'updated'],
        ])
    })
})
