import { LongPollingStatus } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { longPollingStatus } from '../../../../../src/app/trigger/long-polling/long-polling-status'

const put = vi.fn()
const get = vi.fn()
const del = vi.fn()

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    distributedStore: {
        put: (...args: unknown[]) => put(...args),
        get: (...args: unknown[]) => get(...args),
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

    it('clears under the same key it writes', async () => {
        await longPollingStatus.clear(flow)

        expect(del).toHaveBeenCalledWith('long-polling:status:project1:flow1')
    })
})
