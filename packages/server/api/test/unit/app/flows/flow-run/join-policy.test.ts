import { JoinFailurePolicy } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { joinPolicy } from '../../../../../src/app/flows/flow-run/waitpoint/join-waitpoint-service'
import { WaitpointSlot, WaitpointSlotStatus } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-types'

// #374: when a join waitpoint stops waiting, and what it resumes its run with.
describe('joinPolicy.decide', () => {
    it('ALL_SETTLED waits for every slot, then succeeds whatever the answers', () => {
        const join = { slots: 3, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED }
        expect(joinPolicy.decide({ join, slots: slotsOf(['S', 'F', 'P']), expired: false })).toEqual({ done: false })

        const decision = joinPolicy.decide({ join, slots: slotsOf(['S', 'F', 'S']), expired: false })
        expect(decision).toEqual({
            done: true,
            body: {
                status: 'success',
                data: {
                    results: [
                        { status: 'success', data: { index: 0 } },
                        { status: 'error', data: { index: 1 } },
                        { status: 'success', data: { index: 2 } },
                    ],
                    succeeded: 2,
                    failed: 1,
                    timedOut: 0,
                },
            },
        })
    })

    it('FAIL_FAST decides at the first failure and reports unanswered slots as pending', () => {
        const join = { slots: 3, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST }
        expect(joinPolicy.decide({ join, slots: slotsOf(['S', 'P', 'P']), expired: false })).toEqual({ done: false })

        const decision = joinPolicy.decide({ join, slots: slotsOf(['S', 'F', 'P']), expired: false })
        expect(decision.done && decision.body.status).toBe('error')
        expect(decision.done && decision.body.data.results.map((result) => result.status)).toEqual(['success', 'error', 'pending'])
    })

    it('QUORUM succeeds as soon as enough slots succeeded, and fails once the quorum is out of reach', () => {
        const join = { slots: 4, failurePolicy: JoinFailurePolicy.enum.QUORUM, quorum: 2 }
        expect(joinPolicy.decide({ join, slots: slotsOf(['S', 'F', 'P', 'P']), expired: false })).toEqual({ done: false })

        const reached = joinPolicy.decide({ join, slots: slotsOf(['S', 'F', 'S', 'P']), expired: false })
        expect(reached.done && reached.body.status).toBe('success')

        const outOfReach = joinPolicy.decide({ join, slots: slotsOf(['F', 'F', 'S', 'F']), expired: false })
        expect(outOfReach.done && outOfReach.body.status).toBe('error')
    })

    it('on expiry treats every unanswered slot as timed out, and a failure policy counts it as a failure', () => {
        const settled = joinPolicy.decide({ join: { slots: 3, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED }, slots: slotsOf(['S', 'P', 'P']), expired: true })
        expect(settled.done && settled.body).toMatchObject({ status: 'success', data: { succeeded: 1, failed: 0, timedOut: 2 } })
        expect(settled.done && settled.body.data.results.map((result) => result.status)).toEqual(['success', 'timeout', 'timeout'])

        const failFast = joinPolicy.decide({ join: { slots: 2, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST }, slots: slotsOf(['S', 'P']), expired: true })
        expect(failFast.done && failFast.body.status).toBe('error')
    })

    it('orders results by slot, not by the order answers were stored', () => {
        const slots = slotsOf(['S', 'F']).reverse()
        const decision = joinPolicy.decide({ join: { slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED }, slots, expired: false })
        expect(decision.done && decision.body.data.results).toEqual([
            { status: 'success', data: { index: 0 } },
            { status: 'error', data: { index: 1 } },
        ])
    })
})

function slotsOf(statuses: ('S' | 'F' | 'P')[]): WaitpointSlot[] {
    return statuses.map((status, slotIndex) => ({
        id: `slot-${slotIndex}`,
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        waitpointId: 'waitpoint',
        flowRunId: 'run',
        projectId: 'project',
        slotIndex,
        status: STATUS[status],
        payload: status === 'P' ? null : JSON.stringify({ index: slotIndex }),
        childRunId: null,
    }))
}

const STATUS = {
    S: WaitpointSlotStatus.SUCCEEDED,
    F: WaitpointSlotStatus.FAILED,
    P: WaitpointSlotStatus.PENDING,
}
