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

        expect(policy).toEqual(new Map([
            ['flagged', { logInput: true, logOutput: false }],
            ['nested', { logInput: false, logOutput: true }],
        ]))
    })

    // The trigger's payload is where personal data arrives (a Telegram contact share carries a
    // phone number), and until #505 nothing could redact it: only action steps were collected.
    it('collects the trigger\'s own logOutput opt-out, with its input always logged', () => {
        const policy = logRedaction.buildStepLogPolicy({
            trigger: { ...buildTrigger({ nextAction: undefined }), logOutput: false },
        })

        expect(policy).toEqual(new Map([
            ['trigger', { logInput: true, logOutput: false }],
        ]))
    })

    it('adds no entry for a trigger that does not opt out', () => {
        const policy = logRedaction.buildStepLogPolicy({ trigger: buildTrigger({ nextAction: undefined }) })

        expect(policy.size).toBe(0)
    })

    // Blocking finding: a step literally named `__proto__` (admitted by `STEP_NAME_REGEX`, and
    // surviving `ap_import_flow` verbatim) that opts out of logging its output must still show up
    // as an entry `hasPolicy` can see. On a bare `Record` with a bracket assignment, `policy['__proto__']
    // = {...}` never creates an own property — it silently reassigns the object's own prototype via
    // the inherited setter, so `Object.keys(policy)` (the old `hasPolicy` implementation) comes back
    // empty and the whole flow's log redaction is skipped, unredacting exactly the step that asked
    // to be hidden. This must fail on a `Record`-based implementation (`hasPolicy` reports `false`
    // even though a policy was set) and pass with a `Map`.
    it('makes a step literally named "__proto__" visible to hasPolicy, so its own opt-out is not silently defeated', () => {
        const flagged = {
            ...buildQadamAction({ name: '__proto__', qadamName: 'qadam', actionName: 'action', input: {} }),
            logOutput: false,
        }

        const policy = logRedaction.buildStepLogPolicy({
            trigger: buildTrigger({ nextAction: flagged }),
        })

        expect(logRedaction.hasPolicy({ stepLogPolicy: policy })).toBe(true)
    })
})

describe('logRedaction.redactStepsForLog', () => {
    it('replaces only the flagged output, on the copy, leaving the live step untouched', () => {
        const live = buildStepOutput({ output: { secret: 'derived-key' } })
        const other = buildStepOutput({ output: { public: true } })

        const redacted = logRedaction.redactStepsForLog({
            steps: { flagged: live, other },
            stepLogPolicy: new Map([['flagged', { logInput: true, logOutput: false }]]),
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
            stepLogPolicy: new Map([['secret', { logInput: true, logOutput: false }]]),
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
            stepLogPolicy: new Map([['loop', { logInput: true, logOutput: false }]]),
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
