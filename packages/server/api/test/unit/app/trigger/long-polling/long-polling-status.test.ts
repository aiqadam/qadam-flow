import { LongPollingStatus } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { longPollingStatus } from '../../../../../src/app/trigger/long-polling/long-polling-status'

const put = vi.fn()
const get = vi.fn()
const getMany = vi.fn()
const del = vi.fn()

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedStore: {
        put: (...args: unknown[]) => put(...args),
        get: (...args: unknown[]) => get(...args),
        getMany: (...args: unknown[]) => getMany(...args),
        delete: (...args: unknown[]) => del(...args),
    },
}))

const flow = { projectId: 'project1', flowId: 'flow1' }

describe('longPollingStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        get.mockResolvedValue(null)
    })

    it('scopes the key by project as well as flow', async () => {
        await longPollingStatus.get(flow)

        expect(get).toHaveBeenCalledWith('long-polling:status:project1:flow1')
    })

    // Without a TTL a host that dies leaves a "polling" claim standing, and the UI would report
    // a healthy trigger for a bot nothing is listening to.
    it('expires what it writes', async () => {
        await longPollingStatus.report({ ...flow, status: LongPollingStatus.POLLING, since: 'now' })

        const [, , ttlSeconds] = put.mock.calls[0]
        expect(ttlSeconds).toBeGreaterThan(0)
    })

    it('omits the reason entirely rather than storing an explicit undefined', async () => {
        await longPollingStatus.report({ ...flow, status: LongPollingStatus.POLLING, since: 'now' })

        expect(put.mock.calls[0][1]).toEqual({ status: LongPollingStatus.POLLING, since: 'now' })
    })

    it('keeps the reason when there is one to show', async () => {
        await longPollingStatus.report({
            ...flow,
            status: LongPollingStatus.STOPPED,
            reason: 'the webhook is still registered',
            since: 'now',
        })

        expect(put.mock.calls[0][1]).toEqual({
            status: LongPollingStatus.STOPPED,
            reason: 'the webhook is still registered',
            since: 'now',
        })
    })

    // Part of a reason is written by the third party and part by a qadam author. Capping at the
    // store rather than at each call site is what makes the bound hold for every writer.
    it('caps a reason rather than storing whatever arrives', async () => {
        await longPollingStatus.report({
            ...flow,
            status: LongPollingStatus.STOPPED,
            reason: 'x'.repeat(5000),
            since: 'now',
        })

        expect(put.mock.calls[0][1].reason.length).toBeLessThanOrEqual(300)
    })

    it('clears under the same key it writes', async () => {
        await longPollingStatus.clear(flow)

        expect(del).toHaveBeenCalledWith('long-polling:status:project1:flow1')
    })
})

/**
 * The flows list is the page a user watches to notice a bot that has gone quiet, and it reads this
 * for a whole page at once. Two things have to hold: one round trip rather than one per row, and a
 * key built from each row's own project — a list can span projects, and a shared key would read
 * another tenant's slot.
 */
describe('longPollingStatus.getMany', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('asks once for the whole page', async () => {
        getMany.mockResolvedValue([null, null])

        await longPollingStatus.getMany({ flows: [
            { projectId: 'project1', flowId: 'flow1' },
            { projectId: 'project2', flowId: 'flow2' },
        ] })

        expect(getMany).toHaveBeenCalledTimes(1)
    })

    it('keys each flow on its own project, not on the first one', async () => {
        getMany.mockResolvedValue([null, null])

        await longPollingStatus.getMany({ flows: [
            { projectId: 'project1', flowId: 'flow1' },
            { projectId: 'project2', flowId: 'flow2' },
        ] })

        const [keys] = getMany.mock.calls[0]
        expect(keys).toEqual([
            'long-polling:status:project1:flow1',
            'long-polling:status:project2:flow2',
        ])
    })

    it('pairs each state with the flow it was asked for, and drops the misses', async () => {
        const state = { status: LongPollingStatus.POLLING, since: '2026-01-01T00:00:00.000Z' }
        getMany.mockResolvedValue([null, state])

        const result = await longPollingStatus.getMany({ flows: [
            { projectId: 'project1', flowId: 'flow1' },
            { projectId: 'project2', flowId: 'flow2' },
        ] })

        expect(result.get('flow1')).toBeUndefined()
        expect(result.get('flow2')).toEqual(state)
    })

    // An empty page must not reach Redis with an empty MGET, which is an error rather than a no-op.
    it('does not touch the store for an empty page', async () => {
        expect(await longPollingStatus.getMany({ flows: [] })).toEqual(new Map())
        expect(getMany).not.toHaveBeenCalled()
    })
})
