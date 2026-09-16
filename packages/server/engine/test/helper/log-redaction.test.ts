import { FlowActionType, FlowTrigger, FlowTriggerType, GenericStepOutput, LoopStepOutput, StepOutputStatus } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { logRedaction, REDACTED_VALUE } from '../../src/lib/helper/log-redaction'
import { buildQadamAction, buildSimpleLoopAction } from '../handler/test-helper'

const buildTrigger = ({ nextAction }: { nextAction: unknown }): FlowTrigger => ({
    name: 'trigger',
    displayName: 'Trigger',
    type: FlowTriggerType.EMPTY,
    valid: true,
    lastUpdatedDate: '2024-01-01T00:00:00.000Z',
    settings: {},
    nextAction,
})

const buildStepOutput = ({ output }: { output?: unknown }) => GenericStepOutput.create({
    type: FlowActionType.PIECE,
    status: StepOutputStatus.SUCCEEDED,
    input: {},
    output,
})

describe('logRedaction.buildStepLogPolicy', () => {
    it('collects flags from nested steps and skips steps without any', () => {
        const nested = {
            ...buildQadamAction({ name: 'nested', qadamName: 'qadam', actionName: 'action', input: {} }),
            logInput: false,
        }
        const loop = buildSimpleLoopAction({ name: 'loop', loopItems: '[]', firstLoopAction: nested })
        const flagged = {
            ...buildQadamAction({ name: 'flagged', qadamName: 'qadam', actionName: 'action', input: {}, nextAction: loop }),
            logOutput: false,
        }
        const unflagged = buildQadamAction({ name: 'unflagged', qadamName: 'qadam', actionName: 'action', input: {} })

        const policy = logRedaction.buildStepLogPolicy({
            trigger: buildTrigger({
                nextAction: { ...flagged, nextAction: { ...loop, nextAction: unflagged } },
            }),
        })

        expect(policy).toEqual({
            flagged: { logInput: true, logOutput: false },
            nested: { logInput: false, logOutput: true },
        })
    })
})

describe('logRedaction.redactStepsForLog', () => {
    it('replaces only the flagged output, on the copy, leaving the live step untouched', () => {
        const live = buildStepOutput({ output: { secret: 'derived-key' } })
        const other = buildStepOutput({ output: { public: true } })

        const redacted = logRedaction.redactStepsForLog({
            steps: { flagged: live, other },
            stepLogPolicy: { flagged: { logInput: true, logOutput: false } },
        })

        expect(redacted.flagged.output).toBe(REDACTED_VALUE)
        expect(redacted.other).toBe(other)
        expect(live.output).toEqual({ secret: 'derived-key' })
    })

    it('recurses into loop iterations and preserves untouched iterations by reference', () => {
        const secret = buildStepOutput({ output: 'token-123' })
        const publicStep = buildStepOutput({ output: 'public' })
        const loop = LoopStepOutput.init({ input: {} }).setIterations([
            { secret, publicStep },
        ])

        const redacted = logRedaction.redactStepsForLog({
            steps: { loop },
            stepLogPolicy: { secret: { logInput: true, logOutput: false } },
        })

        const redactedLoop = redacted.loop
        if (!(redactedLoop instanceof LoopStepOutput)) {
            throw new Error('Expected the redacted loop step to stay a LoopStepOutput')
        }
        expect(redactedLoop.output.iterations[0].secret.output).toBe(REDACTED_VALUE)
        expect(redactedLoop.output.iterations[0].publicStep).toBe(publicStep)
        expect(loop.output.iterations[0].secret.output).toBe('token-123')
    })

    it('redacts a flagged loop output wholesale, iterations included', () => {
        const loop = LoopStepOutput.init({ input: {} }).setIterations([
            { secret: buildStepOutput({ output: 'token-123' }) },
        ])

        const redacted = logRedaction.redactStepsForLog({
            steps: { loop },
            stepLogPolicy: { loop: { logInput: true, logOutput: false } },
        })

        expect(redacted.loop.output).toBe(REDACTED_VALUE)
    })
})

describe('logRedaction.withRedactedInput', () => {
    it('replaces the input only when logging is off, and is idempotent', () => {
        const stepOutput = buildStepOutput({ output: {} })
        stepOutput.input = { token: 'secret' }

        const untouched = logRedaction.withRedactedInput(stepOutput, { logInput: true, logOutput: true })
        const redacted = logRedaction.withRedactedInput(stepOutput, { logInput: false, logOutput: true })
        const redactedTwice = logRedaction.withRedactedInput(redacted, { logInput: false, logOutput: true })

        expect(untouched).toBe(stepOutput)
        expect(redacted.input).toBe(REDACTED_VALUE)
        expect(redactedTwice).toBe(redacted)
        expect(stepOutput.input).toEqual({ token: 'secret' })
    })
})
