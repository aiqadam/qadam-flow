import { FlowActionType, FlowRunStatus, GenericStepOutput, StepOutputStatus } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

// #387 benchmark: engine overhead per loop iteration as the item count grows. Opt-in
// (`ENGINE_BENCH=1`) because wall-clock numbers are not a pass/fail signal on shared CI runners;
// the deterministic guard against the quadratic regressions lives in `flow-looping.test.ts`.
describe.skipIf(!process.env.ENGINE_BENCH)('loop overhead benchmark', () => {
    // A dev qadam re-scans every qadam's dist folder on each step (`qadamLoader.getQadamPath`), a
    // cost production never pays; measured with dev qadams on, every iteration reads ~120 ms of
    // directory listing and the benchmark says nothing about the engine.
    beforeAll(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
    })
    afterAll(() => {
        vi.restoreAllMocks()
    })

    it.each(benchCounts())('%i iterations × 2 steps', async (count) => {
        const items = Array.from({ length: count }, (_, i) => ({ chatId: 100000 + i, text: `message number ${i} `.repeat(8) }))
        const plainLoop = buildSimpleLoopAction({
            name: 'loop',
            loopItems: '{{ trigger.output.items }}',
            firstLoopAction: {
                ...buildQadamAction({
                    name: 'render',
                    qadamName: '@aiqadam/qadam-data-mapper',
                    actionName: 'advanced_mapping',
                    input: { mapping: { chat_id: '{{ loop.output.item.chatId }}', text: '{{ loop.output.item.text }}' } },
                }),
                nextAction: buildQadamAction({
                    name: 'send',
                    qadamName: '@aiqadam/qadam-data-mapper',
                    actionName: 'advanced_mapping',
                    input: { mapping: { ok: true, result: { message_id: '{{ loop.output.index }}', chat: '{{ render.output.chat_id }}', text: '{{ render.output.text }}' } } },
                }),
            },
        })
        // Collects one field per iteration, the way a bulk send reports what it sent (#41, #387).
        const loop = { ...plainLoop, settings: { ...plainLoop.settings, collect: { value: '{{ send.output.result.message_id }}' } } }
        const state = await FlowExecutorContext.empty().upsertStep('trigger', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: { items },
        }))

        const startedAt = performance.now()
        const result = await flowExecutor.execute({ action: loop, executionState: state, constants: generateMockEngineConstants({ stepNames: ['trigger', 'loop', 'render', 'send'] }) })
        const elapsedMs = performance.now() - startedAt

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        console.info(`[loop-bench] n=${count} total=${elapsedMs.toFixed(0)}ms perIteration=${(elapsedMs / count).toFixed(2)}ms`)
    }, 600000)
})

function benchCounts(): number[] {
    const fromEnv = process.env.ENGINE_BENCH_COUNTS
    return fromEnv ? fromEnv.split(',').map(Number) : [100, 1000, 3000]
}
