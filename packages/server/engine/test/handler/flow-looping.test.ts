import { FlowAction, FlowRunStatus, LoopStepOutput } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import {  FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { sizeofUtils } from '../../src/lib/helper/sizeof'
import { buildCodeAction, buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'


describe('flow with looping', () => {

    it('should execute iterations', async () => {
        const codeAction = buildCodeAction({
            name: 'echo_step',
            input: {
                'index': '{{loop.output.index}}',
            },
        })
        const result = await flowExecutor.execute({
            action: buildSimpleLoopAction({
                name: 'loop',
                loopItems: '{{ [4,5,6] }}',
                firstLoopAction: codeAction,
            }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop'] }),
        })

        const loopOut = result.steps.loop as LoopStepOutput
        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loopOut.output?.iterations.length).toBe(3)
        expect(loopOut.output?.index).toBe(3)
        expect(loopOut.output?.item).toBe(6)
    })

    it('should execute iterations and fail on first iteration', async () => {
        const generateArray = buildCodeAction({
            name: 'echo_step',
            input: {
                'array': '{{ [4,5,6] }}',
            },
            nextAction: buildSimpleLoopAction({
                name: 'loop',
                loopItems: '{{ echo_step.output.array }}',
                firstLoopAction: buildCodeAction({
                    name: 'runtime',
                    input: {},
                }),
            }),
        })
        const result = await flowExecutor.execute({
            action: generateArray,
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['echo_step'] }),
        })

        const loopOut = result.steps.loop as LoopStepOutput
        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(loopOut.output?.iterations.length).toBe(1)
        expect(loopOut.output?.index).toBe(1)
        expect(loopOut.output?.item).toBe(4)
    })

    it('should skip loop', async () => {
        const result = await flowExecutor.execute({
            action: buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [4,5,6] }}', skip: true }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(result.steps.loop).toBeUndefined()
    })

    it('should skip loop in flow', async () => {
        const flow: FlowAction = {
            ...buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [4,5,6] }}', skip: true }),
            nextAction: {
                ...buildCodeAction({
                    name: 'echo_step',
                    skip: false,
                    input: {
                        'key': '{{ 1 + 2 }}',
                    },
                }),
                nextAction: undefined,
            },
        }
        const result = await flowExecutor.execute({
            action: flow, executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(result.steps.loop).toBeUndefined()
        expect(result.steps.echo_step.output).toEqual({ 'key': 3 })
    })

})

// #387: the log-size check used to walk the whole journal after every step, which made a loop
// quadratic in its item count (52 ms per iteration at 3000). The walk now runs a bounded number of
// times per run, whatever the item count.
describe('loop log-size check cost', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('does not walk the whole journal once per step', async () => {
        // A dev qadam re-scans every dist folder on each step; that is test-only cost, not the
        // engine's, and would make this case take minutes.
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        const walk = vi.spyOn(sizeofUtils, 'recursiveSizeof')
        const executionState = FlowExecutorContext.empty()

        const result = await flowExecutor.execute({
            action: buildSimpleLoopAction({
                name: 'loop',
                loopItems: '{{ Array.from({ length: 300 }, (_, i) => i) }}',
                firstLoopAction: buildQadamAction({
                    name: 'map',
                    qadamName: '@aiqadam/qadam-data-mapper',
                    actionName: 'advanced_mapping',
                    input: { mapping: { value: '{{ loop.output.item }}' } },
                }),
            }),
            executionState,
            constants: generateMockEngineConstants({ stepNames: ['loop', 'map'] }),
        })

        const loopOut = result.steps.loop as LoopStepOutput
        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loopOut.output?.iterations).toHaveLength(300)
        const fullWalks = walk.mock.calls.filter(([value]) => value === executionState.steps)
        expect(fullWalks.length).toBeLessThanOrEqual(2)
    }, 60000)
})
