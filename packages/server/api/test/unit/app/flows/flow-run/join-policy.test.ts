import { JoinFailurePolicy } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { joinPolicy } from '../../../../../src/app/flows/flow-run/waitpoint/join-waitpoint-service'
import { WaitpointSlot, WaitpointSlotStatus } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-types'

// #374: when a join waitpoint stops waiting, decided from counts alone, and what it resumes with.
describe('joinPolicy.decide', () => {
    it('ALL_SETTLED waits for every slot, then succeeds whatever the answers', () => {
        const join = { slots: 3, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED }
        expect(joinPolicy.decide({ join, counts: countsOf('SFP'), expired: false })).toEqual({ done: false })
        expect(joinPolicy.decide({ join, counts: countsOf('SFS'), expired: false })).toEqual({ done: true, status: 'success' })
    })

    it('FAIL_FAST decides at the first failure', () => {
        const join = { slots: 3, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST }
        expect(joinPolicy.decide({ join, counts: countsOf('SPP'), expired: false })).toEqual({ done: false })
        expect(joinPolicy.decide({ join, counts: countsOf('SFP'), expired: false })).toEqual({ done: true, status: 'error' })
        expect(joinPolicy.decide({ join, counts: countsOf('SSS'), expired: false })).toEqual({ done: true, status: 'success' })
    })

    it('QUORUM succeeds as soon as enough slots succeeded, and fails once the quorum is out of reach', () => {
        const join = { slots: 4, failurePolicy: JoinFailurePolicy.enum.QUORUM, quorum: 2 }
        expect(joinPolicy.decide({ join, counts: countsOf('SFPP'), expired: false })).toEqual({ done: false })
        expect(joinPolicy.decide({ join, counts: countsOf('SFSP'), expired: false })).toEqual({ done: true, status: 'success' })
        expect(joinPolicy.decide({ join, counts: countsOf('FFSF'), expired: false })).toEqual({ done: true, status: 'error' })
    })

    it('on expiry treats every unanswered slot as timed out, which a failure policy counts as a failure', () => {
        expect(joinPolicy.decide({ join: { slots: 3, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED }, counts: countsOf('SPP'), expired: true })).toEqual({ done: true, status: 'success' })
        expect(joinPolicy.decide({ join: { slots: 2, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST }, counts: countsOf('SP'), expired: true })).toEqual({ done: true, status: 'error' })
    })
})

describe('joinPolicy.buildResult', () => {
    it('reports every answer in slot order, whatever order the rows came back in', () => {
        const result = joinPolicy.buildResult({ slots: slotsOf('SFP').reverse(), expired: false })
        expect(result).toEqual({
            results: [
                { status: 'success', data: { index: 0 } },
                { status: 'error', data: { index: 1 } },
                { status: 'pending', data: null },
            ],
            succeeded: 1,
            failed: 1,
            timedOut: 0,
        })
    })

    it('reports unanswered slots as timed out on expiry', () => {
        const result = joinPolicy.buildResult({ slots: slotsOf('SPT'), expired: true })
        expect(result.results.map((entry) => entry.status)).toEqual(['success', 'timeout', 'timeout'])
        expect(result.timedOut).toBe(2)
    })
})

function countsOf(statuses: string): { succeeded: number, failed: number, timedOut: number, pending: number, total: number } {
    const count = (letter: string): number => [...statuses].filter((status) => status === letter).length
    return { succeeded: count('S'), failed: count('F'), timedOut: count('T'), pending: count('P'), total: statuses.length }
}

function slotsOf(statuses: string): WaitpointSlot[] {
    return [...statuses].map((status, slotIndex) => ({
        id: `slot-${slotIndex}`,
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        waitpointId: 'waitpoint',
        flowRunId: 'run',
        projectId: 'project',
        slotIndex,
        status: STATUS[status],
        payload: status === 'S' || status === 'F' ? JSON.stringify({ index: slotIndex }) : null,
        childRunId: null,
    }))
}

const STATUS: Record<string, WaitpointSlotStatus> = {
    S: WaitpointSlotStatus.SUCCEEDED,
    F: WaitpointSlotStatus.FAILED,
    P: WaitpointSlotStatus.PENDING,
    T: WaitpointSlotStatus.TIMED_OUT,
}
