import { describe, expect, it } from 'vitest'
import { qadamPinHold } from '../../../../src/app/qadams/pin-moves/qadam-pin-hold'

function step({ qadamVersion }: { qadamVersion: string }): Parameters<typeof qadamPinHold.findForStep>[0]['step'] {
    return {
        name: 'step_1',
        settings: {
            qadamName: '@aiqadam/qadam-test-email',
            qadamVersion,
        },
    }
}

function move({ overrides }: { overrides?: Partial<Parameters<typeof qadamPinHold.findForStep>[0]['moves'][number]> } = {}): Parameters<typeof qadamPinHold.findForStep>[0]['moves'][number] {
    return {
        status: 'REVERTED',
        stepName: 'step_1',
        qadamName: '@aiqadam/qadam-test-email',
        fromVersion: '1.3.0-main.412',
        toVersion: '1.3.0-main.500',
        revertedAt: '2026-10-10T12:00:00.000Z',
        ...overrides,
    }
}

describe('qadamPinHold.findForStep (ADR-0004, #854)', () => {
    it('matches the step, qadam and exact version a revert restored', () => {
        const hold = qadamPinHold.findForStep({ step: step({ qadamVersion: '~1.3.0-main.412' }), moves: [move()] })

        expect(hold).toMatchObject({ fromVersion: '1.3.0-main.412', toVersion: '1.3.0-main.500' })
    })

    it('does not hold a step from a move that was not reverted', () => {
        expect(qadamPinHold.findForStep({ step: step({ qadamVersion: '1.3.0-main.412' }), moves: [move({ overrides: { status: 'APPLIED' } })] })).toBeNull()
    })

    it('does not hold a step whose version changed after the revert', () => {
        expect(qadamPinHold.findForStep({ step: step({ qadamVersion: '1.3.0' }), moves: [move()] })).toBeNull()
    })

    it('does not hold another step or another qadam', () => {
        expect(qadamPinHold.findForStep({ step: step({ qadamVersion: '1.3.0-main.412' }), moves: [move({ overrides: { stepName: 'step_2' } })] })).toBeNull()
        expect(qadamPinHold.findForStep({ step: step({ qadamVersion: '1.3.0-main.412' }), moves: [move({ overrides: { qadamName: '@aiqadam/qadam-other' } })] })).toBeNull()
    })

    it('returns the newest record when the same version was reverted more than once', () => {
        const older = move({ overrides: { toVersion: '1.3.0-main.450', revertedAt: '2026-10-09T12:00:00.000Z' } })
        const newer = move({ overrides: { toVersion: '1.3.0-main.500', revertedAt: new Date('2026-10-10T12:00:00.000Z') } })

        expect(qadamPinHold.findForStep({ step: step({ qadamVersion: '1.3.0-main.412' }), moves: [older, newer] })).toMatchObject({ toVersion: '1.3.0-main.500' })
    })
})
