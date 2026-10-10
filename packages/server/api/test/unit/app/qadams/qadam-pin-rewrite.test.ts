import { FlowAction, FlowActionType, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState, PropertyExecutionType } from '@aiqadam/shared'
import { qadamPinRewrite } from '../../../../src/app/qadams/pin-moves/qadam-pin-rewrite'

const NAME = '@aiqadam/qadam-fixture'

describe('qadamPinRewrite.apply', () => {
    it('rewrites the version of the named step and nothing else', () => {
        const flowVersion = flowVersionOf({ pins: ['0.4.2', '0.4.2', '0.3.1'] })

        const rewritten = qadamPinRewrite.apply({ flowVersion, rewrite: { stepName: 'step_2', qadamName: NAME, fromVersion: '0.4.2', toVersion: '0.4.5' } })

        expect(pinsOf({ flowVersion: rewritten })).toEqual(['0.4.2', '0.4.5', '0.3.1'])
        expect(pinsOf({ flowVersion })).toEqual(['0.4.2', '0.4.2', '0.3.1'])
    })

    it('rewrites the trigger', () => {
        const rewritten = qadamPinRewrite.apply({ flowVersion: flowVersionOf({ pins: ['0.4.2'] }), rewrite: { stepName: 'trigger', qadamName: NAME, fromVersion: '0.4.2', toVersion: '0.4.5' } })

        expect(pinsOf({ flowVersion: rewritten })).toEqual(['0.4.5'])
    })

    it.each([
        { name: 'it is on another version', rewrite: { stepName: 'step_2', qadamName: NAME, fromVersion: '0.4.9', toVersion: '0.4.5' } },
        { name: 'it is another qadam', rewrite: { stepName: 'step_2', qadamName: '@aiqadam/qadam-other', fromVersion: '0.4.2', toVersion: '0.4.5' } },
        { name: 'there is no such step', rewrite: { stepName: 'step_9', qadamName: NAME, fromVersion: '0.4.2', toVersion: '0.4.5' } },
    ])('answers null when $name, so a stale plan writes nothing', ({ rewrite }) => {
        expect(qadamPinRewrite.apply({ flowVersion: flowVersionOf({ pins: ['0.4.2', '0.4.2'] }), rewrite })).toBeNull()
    })

    it('does not reach into a step named like an Object property', () => {
        const flowVersion = flowVersionOf({ pins: ['0.4.2', '0.4.2'], names: ['trigger', 'constructor'] })

        const rewritten = qadamPinRewrite.apply({ flowVersion, rewrite: { stepName: 'constructor', qadamName: NAME, fromVersion: '0.4.2', toVersion: '0.4.5' } })

        expect(pinsOf({ flowVersion: rewritten })).toEqual(['0.4.2', '0.4.5'])
    })
})

describe('qadamPinRewrite.applyAll', () => {
    it('applies what it can and reports what it could not', () => {
        const result = qadamPinRewrite.applyAll({
            flowVersion: flowVersionOf({ pins: ['0.4.2', '0.4.2', '0.4.2'] }),
            rewrites: [
                { stepName: 'step_2', qadamName: NAME, fromVersion: '0.4.2', toVersion: '0.4.5' },
                { stepName: 'step_3', qadamName: NAME, fromVersion: '0.4.0', toVersion: '0.4.5' },
            ],
        })

        expect(pinsOf({ flowVersion: result.flowVersion })).toEqual(['0.4.2', '0.4.5', '0.4.2'])
        expect(result.applied.map((rewrite) => rewrite.stepName)).toEqual(['step_2'])
        expect(result.skipped.map((rewrite) => rewrite.stepName)).toEqual(['step_3'])
    })
})

function flowVersionOf({ pins, names }: { pins: string[], names?: string[] }): FlowVersion {
    const stepNames = names ?? pins.map((_, index) => index === 0 ? 'trigger' : `step_${index + 1}`)
    const [first, ...rest] = pins
    const actions = rest.map((pin, index) => pieceAction({ name: stepNames[index + 1], qadamVersion: pin }))
    const trigger: FlowTrigger = {
        type: FlowTriggerType.PIECE,
        name: stepNames[0],
        displayName: 'Trigger',
        valid: true,
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: { qadamName: NAME, qadamVersion: first, triggerName: 'do_it', input: {}, propertySettings: {} },
        nextAction: actions.reduceRight<FlowAction | undefined>((next, action) => ({ ...action, nextAction: next }), undefined),
    }
    return {
        id: 'flowversionid0000000001',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        flowId: 'flowid0000000000000001',
        displayName: 'Flow',
        trigger,
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
}

function pieceAction({ name, qadamVersion }: { name: string, qadamVersion: string }): FlowAction {
    return {
        type: FlowActionType.PIECE,
        name,
        displayName: name,
        valid: true,
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: {
            qadamName: NAME,
            qadamVersion,
            actionName: 'do_it',
            input: {},
            propertySettings: { value: { type: PropertyExecutionType.MANUAL } },
            errorHandlingOptions: {},
        },
    }
}

function pinsOf({ flowVersion }: { flowVersion: FlowVersion | null }): string[] {
    const versions: string[] = []
    let step: { settings?: { qadamVersion?: string }, nextAction?: unknown } | undefined = flowVersion?.trigger
    while (step !== undefined) {
        versions.push(step.settings?.qadamVersion ?? '')
        step = typeof step.nextAction === 'object' && step.nextAction !== null ? step.nextAction : undefined
    }
    return versions
}
