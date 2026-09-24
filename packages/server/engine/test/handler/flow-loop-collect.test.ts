import { FlowAction, FlowActionType, FlowRunStatus, LoopExecutionMode, LoopIterationStatus, LoopKeepBodies, LoopOnItemsAction, LoopStepOutput, LoopStepResult, StepOutputStatus } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { buildCodeAction, buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

// #41: a loop collects one value per iteration, positionally, without a CODE step walking
// `iterations[i].step.output`.
describe('loop collector', () => {
    beforeEach(() => {
        // Dev qadams re-scan every dist folder per step — test-only cost unrelated to the loop.
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const mapStep = buildQadamAction({
        name: 'map',
        qadamName: '@aiqadam/qadam-data-mapper',
        actionName: 'advanced_mapping',
        input: { mapping: { doubled: '{{ loop.output.item * 2 }}' } },
    })

    const failingHttpStep = buildQadamAction({
        name: 'fetch',
        qadamName: '@aiqadam/qadam-http',
        actionName: 'send_request',
        input: {
            method: 'GET',
            url: 'http://127.0.0.1:1/unused',
            headers: {},
            queryParams: {},
            body_type: 'none',
            body: {},
        },
        errorHandlingOptions: { continueOnFailure: { value: true }, retryOnFailure: { value: false } },
    })

    const loopWith = ({ settings, firstLoopAction, items = '{{ [1, 2, 3] }}' }: { settings: Partial<LoopOnItemsAction['settings']>, firstLoopAction: FlowAction, items?: string }): LoopOnItemsAction => {
        const loop = buildSimpleLoopAction({ name: 'loop', loopItems: items, firstLoopAction })
        return { ...loop, settings: { ...loop.settings, ...settings } }
    }

    const run = async ({ action, executionState = FlowExecutorContext.empty() }: { action: FlowAction, executionState?: FlowExecutorContext }): Promise<{ result: FlowExecutorContext, loop: { output?: LoopStepResult } }> => {
        const result = await flowExecutor.execute({
            action,
            executionState,
            constants: generateMockEngineConstants({ stepNames: ['loop', 'map', 'fetch', 'runtime'] }),
        })
        return { result, loop: readLoop(result) }
    }

    const restoredLoop = (output: LoopStepResult): LoopStepOutput => new LoopStepOutput({
        type: FlowActionType.LOOP_ON_ITEMS,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output,
    })

    it('collects one value per iteration, by position', async () => {
        const { result, loop } = await run({
            action: loopWith({ settings: { collect: { value: '{{ map.output.doubled }}' } }, firstLoopAction: mapStep }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loop.output?.collected).toEqual([2, 4, 6])
        expect(loop.output?.iterationStatus).toEqual([LoopIterationStatus.SUCCEEDED, LoopIterationStatus.SUCCEEDED, LoopIterationStatus.SUCCEEDED])
        expect(loop.output?.failures).toEqual([])
        expect(loop.output?.item).toBe(3)
        expect(loop.output?.index).toBe(3)
    })

    it('keeps no collected array when nothing is collected', async () => {
        const { loop } = await run({ action: loopWith({ settings: {}, firstLoopAction: mapStep }) })

        expect(loop.output?.collected).toBeUndefined()
        expect(loop.output?.iterations[0]).toHaveProperty('map')
    })

    it('blanks every finished body with keepBodies NONE, keeping positions', async () => {
        const { loop } = await run({
            action: loopWith({ settings: { keepBodies: LoopKeepBodies.NONE, collect: { value: '{{ map.output.doubled }}' } }, firstLoopAction: mapStep }),
        })

        expect(loop.output?.iterations).toEqual([{}, {}, {}])
        expect(loop.output?.collected).toEqual([2, 4, 6])
    })

    it('keeps only bodies with a failed step under FAILED_ONLY, and skipFailed leaves them out', async () => {
        const failingThenMapping: FlowAction = { ...failingHttpStep, nextAction: mapStep }
        const { result, loop } = await run({
            action: loopWith({
                settings: { keepBodies: LoopKeepBodies.FAILED_ONLY, collect: { value: '{{ map.output.doubled }}', skipFailed: true } },
                firstLoopAction: failingThenMapping,
                items: '{{ [1] }}',
            }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loop.output?.iterations[0].fetch.status).toBe(StepOutputStatus.FAILED)
        expect(loop.output?.collected).toEqual([null])
        expect(loop.output?.iterationStatus).toEqual([LoopIterationStatus.SUCCEEDED])
        expect(loop.output?.failures).toEqual([])
    }, 20000)

    it('records a failed iteration compactly and stops', async () => {
        const { result, loop } = await run({
            action: loopWith({ settings: { collect: { value: '{{ 1 }}' } }, firstLoopAction: buildCodeAction({ name: 'runtime', input: {} }) }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(loop.output?.iterationStatus).toEqual([LoopIterationStatus.FAILED])
        expect(loop.output?.collected).toEqual([null])
        expect(loop.output?.failures).toHaveLength(1)
        expect(loop.output?.failures?.[0]).toMatchObject({ index: 0, stepName: 'runtime' })
        expect(loop.output?.failures?.[0].description).toContain('Custom Runtime Error')
    })

    it('skips an iteration already marked succeeded without entering its blanked body', async () => {
        const restored = await FlowExecutorContext.empty().upsertStep('loop', restoredLoop({
            item: 2,
            index: 2,
            iterations: [{}, {}],
            iterationStatus: [LoopIterationStatus.SUCCEEDED, LoopIterationStatus.SUCCEEDED],
            failures: [],
            collected: ['kept-0', 'kept-1'],
        }))

        const { loop } = await run({
            action: loopWith({ settings: { keepBodies: LoopKeepBodies.ALL, collect: { value: '{{ map.output.doubled }}' } }, firstLoopAction: mapStep }),
            executionState: restored,
        })

        expect(loop.output?.iterations[0]).toEqual({})
        expect(loop.output?.iterations[1]).toEqual({})
        expect(loop.output?.iterations[2]).toHaveProperty('map')
        expect(loop.output?.collected).toEqual(['kept-0', 'kept-1', 6])
    })

    it('re-runs exactly the failed iteration and clears its failure once it succeeds', async () => {
        const restored = await FlowExecutorContext.empty().upsertStep('loop', restoredLoop({
            item: 2,
            index: 2,
            iterations: [{}, {}],
            iterationStatus: [LoopIterationStatus.SUCCEEDED, LoopIterationStatus.FAILED],
            failures: [{ index: 1, stepName: 'map', description: 'boom' }],
            collected: ['kept-0', null],
        }))

        const { loop } = await run({
            action: loopWith({ settings: { keepBodies: LoopKeepBodies.NONE, collect: { value: '{{ map.output.doubled }}' } }, firstLoopAction: mapStep, items: '{{ [1, 2] }}' }),
            executionState: restored,
        })

        expect(loop.output?.iterationStatus).toEqual([LoopIterationStatus.SUCCEEDED, LoopIterationStatus.SUCCEEDED])
        expect(loop.output?.failures).toEqual([])
        expect(loop.output?.collected).toEqual(['kept-0', 4])
    })

    it('collects one value per item from a loop with no steps in its body', async () => {
        const loop = buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [{ id: 1 }, { id: 2 }] }}' })
        const { loop: output } = await run({ action: { ...loop, settings: { ...loop.settings, collect: { value: '{{ loop.output.item.id }}' } } } })

        expect(output.output?.collected).toEqual([1, 2])
    })

    it('shows the shape of collected when the loop step alone is tested', async () => {
        const result = await flowExecutor.execute({
            action: loopWith({ settings: { collect: { value: '{{ loop.output.item }}' } }, firstLoopAction: mapStep }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop'], stepNameToTest: 'loop' }),
        })
        expect(readLoop(result).output?.collected).toEqual([1])
    })
})


describe('loop collector — stop, nesting and pauses', () => {
    beforeEach(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const collecting = ({ name, items, value, firstLoopAction, execution }: { name: string, items: string, value: string, firstLoopAction: FlowAction, execution?: LoopOnItemsAction['settings']['execution'] }): LoopOnItemsAction => {
        const loop = buildSimpleLoopAction({ name, loopItems: items, firstLoopAction })
        return { ...loop, settings: { ...loop.settings, collect: { value }, execution } }
    }

    it('records an iteration that stopped the flow as succeeded, not failed', async () => {
        const stop = buildQadamAction({
            name: 'respond',
            qadamName: '@aiqadam/qadam-webhook',
            actionName: 'return_response',
            input: { respond: 'stop', responseType: 'json', fields: { status: 200, headers: {}, body: { done: true } } },
        })
        const result = await flowExecutor.execute({
            action: collecting({ name: 'loop', items: '{{ [1, 2] }}', value: '{{ loop.output.item }}', firstLoopAction: stop }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop', 'respond'] }),
        })
        const loop = readLoop(result).output

        expect(result.verdict.status).toBe(FlowRunStatus.SUCCEEDED)
        expect(loop?.iterationStatus).toEqual([LoopIterationStatus.SUCCEEDED])
        expect(loop?.failures).toEqual([])
        expect(loop?.collected).toEqual([1])
    })

    it('gives each concurrent outer iteration its own items for the inner loop', async () => {
        const inner = collecting({
            name: 'inner',
            items: '{{ [loop.output.item * 10, loop.output.item * 10 + 1] }}',
            value: '{{ inner.output.item }}',
            firstLoopAction: buildQadamAction({ name: 'map', qadamName: '@aiqadam/qadam-data-mapper', actionName: 'advanced_mapping', input: { mapping: { v: '{{ inner.output.item }}' } } }),
        })
        const outer = collecting({
            name: 'loop',
            items: '{{ [1, 2, 3] }}',
            value: '{{ inner.output.collected }}',
            firstLoopAction: inner,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 3 },
        })

        const result = await flowExecutor.execute({
            action: outer,
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop', 'inner', 'map'] }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(readLoop(result).output?.collected).toEqual([[10, 11], [20, 21], [30, 31]])
    })

    it('leaves a paused iteration unrecorded so a resume enters it again', async () => {
        vi.spyOn(waitpointClient, 'create').mockResolvedValue({ id: 'wp', resumeUrl: 'http://localhost:4200/api/v1/flow-runs/run-1/waitpoints/wp' })
        const delay = buildQadamAction({ name: 'wait', qadamName: '@aiqadam/qadam-delay', actionName: 'delayFor', input: { unit: 'seconds', delayFor: 60 } })

        const result = await flowExecutor.execute({
            action: collecting({ name: 'loop', items: '{{ [1, 2] }}', value: '{{ loop.output.item }}', firstLoopAction: delay }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop', 'wait'] }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.PAUSED)
        expect(readLoop(result).output?.iterationStatus).toEqual([])
    })
})

function readLoop(result: FlowExecutorContext): { output?: LoopStepResult } {
    const step = result.steps.loop
    if (step?.type !== FlowActionType.LOOP_ON_ITEMS) {
        throw new Error('loop step missing from the journal')
    }
    return step
}
