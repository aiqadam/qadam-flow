import { beforeEach, describe, expect, it } from 'vitest'
import { longPollingServed } from '../../../../../src/app/trigger/long-polling/long-polling-served'

describe('longPollingServed', () => {
    beforeEach(() => {
        longPollingServed.clear()
    })

    it('knows nothing until the host tells it', () => {
        expect(longPollingServed.isServedByPulling('flow1')).toBe(false)
    })

    it('answers for the flows it was given', () => {
        longPollingServed.replaceAll(['flow1', 'flow2'])

        expect(longPollingServed.isServedByPulling('flow1')).toBe(true)
        expect(longPollingServed.isServedByPulling('flow3')).toBe(false)
    })

    // Replaces rather than merges: a flow switched back to webhook delivery must start accepting
    // pushed deliveries again on the next reconciliation, not stay refused forever.
    it('forgets a flow that is no longer pull-served', () => {
        longPollingServed.replaceAll(['flow1', 'flow2'])
        longPollingServed.replaceAll(['flow2'])

        expect(longPollingServed.isServedByPulling('flow1')).toBe(false)
        expect(longPollingServed.isServedByPulling('flow2')).toBe(true)
    })

    // With the host off nothing polls, so pushed delivery is the only delivery there is.
    it('refuses nothing once cleared', () => {
        longPollingServed.replaceAll(['flow1'])
        longPollingServed.clear()

        expect(longPollingServed.isServedByPulling('flow1')).toBe(false)
    })
})
