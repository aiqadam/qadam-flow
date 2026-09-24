import { FlowRunStatus, FlowTrigger, FlowTriggerType, LoopOnItemsAction } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { logRedaction, REDACTED_VALUE } from '../../src/lib/helper/log-redaction'
import { buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

describe('step log redaction across a run', () => {
    it('keeps the live output readable by the next step while the logged copy is redacted', async () => {
        const constants = generateMockEngineConstants({
            stepNames: ['step_1', 'step_2'],
            stepLogPolicy: new Map([['step_1', { logInput: true, logOutput: false }]]),
        })
        let state = FlowExecutorContext.empty({ stepLogPolicy: constants.stepLogPolicy })

        state = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_1',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{ 1 + 2 }}' } },
            }),
            executionState: state,
            constants,
        })
        state = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_2',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{ step_1.output.key }}' } },
            }),
            executionState: state,
            constants,
        })

        expect(state.verdict).toStrictEqual({ status: FlowRunStatus.RUNNING })
        expect(state.getStepOutput('step_1')?.output).toEqual({ key: 3 })
        expect(state.getStepOutput('step_2')?.output).toEqual({ key: 3 })
        expect(state.stepsForLog().step_1.output).toBe(REDACTED_VALUE)
        expect(state.stepsForLog().step_2.output).toEqual({ key: 3 })
    })
})

// #41: `collected` holds what `collect.value` read. A value read from a step that does not log its
// output must not reach the log through the loop instead.
describe('loop collector log redaction', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('redacts collected values read from a step that does not log its output', async () => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        const secretStep = { ...buildQadamAction({
            name: 'secret',
            qadamName: '@aiqadam/qadam-data-mapper',
            actionName: 'advanced_mapping',
            input: { mapping: { token: '{{ "tok-" + loop.output.item }}' } },
        }), logOutput: false }
        const baseLoop = buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [1, 2] }}', firstLoopAction: secretStep })
        const loop: LoopOnItemsAction = { ...baseLoop, settings: { ...baseLoop.settings, collect: { value: '{{ secret.output.token }}' } } }
        const trigger: FlowTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            type: FlowTriggerType.EMPTY,
            valid: true,
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            settings: {},
            nextAction: loop,
        }
        const stepLogPolicy = logRedaction.buildStepLogPolicy({ trigger })
        const constants = generateMockEngineConstants({ stepNames: ['trigger', 'loop', 'secret'], stepLogPolicy })

        const state = await flowExecutor.execute({
            action: loop,
            executionState: FlowExecutorContext.empty({ stepLogPolicy }),
            constants,
        })

        expect(stepLogPolicy.get('loop')?.redactCollected).toBe(true)
        expect(state.getStepOutput('loop')?.output).toMatchObject({ collected: ['tok-1', 'tok-2'] })
        expect(state.stepsForLog().loop.output).toMatchObject({ collected: [REDACTED_VALUE, REDACTED_VALUE] })
    })

    it('leaves collected alone when it reads only logged steps', () => {
        const baseLoop = buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [1] }}' })
        const trigger: FlowTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            type: FlowTriggerType.EMPTY,
            valid: true,
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            settings: {},
            nextAction: { ...baseLoop, settings: { ...baseLoop.settings, collect: { value: '{{ loop.output.item }}' } } },
        }

        expect(logRedaction.buildStepLogPolicy({ trigger }).get('loop')).toBeUndefined()
    })
})

// The whole iteration is in scope while `collect.value` runs, so naming an unlogged step is not
// the only way to read it; one loop can also collect another's results.
describe('loop collector log redaction — indirect reads', () => {
    const triggerWith = (nextAction: FlowTrigger['nextAction']): FlowTrigger => ({
        name: 'trigger',
        displayName: 'Trigger',
        type: FlowTriggerType.EMPTY,
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        settings: {},
        nextAction,
    })
    const collectingLoop = ({ name, value, firstLoopAction, nextAction }: { name: string, value: string, firstLoopAction?: FlowTrigger['nextAction'], nextAction?: FlowTrigger['nextAction'] }): LoopOnItemsAction => {
        const base = buildSimpleLoopAction({ name, loopItems: '{{ [1] }}', firstLoopAction })
        return { ...base, settings: { ...base.settings, collect: { value } }, nextAction }
    }
    const unlogged = { ...buildQadamAction({ name: 'secret', qadamName: '@aiqadam/qadam-data-mapper', actionName: 'advanced_mapping', input: {} }), logOutput: false }

    it('redacts a loop whose body holds an unlogged step it does not name', () => {
        const policy = logRedaction.buildStepLogPolicy({ trigger: triggerWith(collectingLoop({ name: 'loop', value: '{{ Array.from(arguments) }}', firstLoopAction: unlogged })) })

        expect(policy.get('loop')?.redactCollected).toBe(true)
    })

    it('redacts a loop that collects a redacted loop', () => {
        const inner = collectingLoop({ name: 'first', value: '{{ secret.output }}', firstLoopAction: unlogged })
        const trigger = triggerWith({ ...inner, nextAction: collectingLoop({ name: 'second', value: '{{ first.output.collected }}' }) })

        const policy = logRedaction.buildStepLogPolicy({ trigger })

        expect(policy.get('first')?.redactCollected).toBe(true)
        expect(policy.get('second')?.redactCollected).toBe(true)
    })

    it('redacts a loop that collects connections or variables', () => {
        const policy = logRedaction.buildStepLogPolicy({ trigger: triggerWith(collectingLoop({ name: 'loop', value: "{{ connections['key'] }}" })) })

        expect(policy.get('loop')?.redactCollected).toBe(true)
    })
})
