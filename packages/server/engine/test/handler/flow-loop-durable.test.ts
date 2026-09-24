import { FlowAction, FlowActionType, FlowRunStatus, LoopCheckpointReason, LoopExecutionMode, LoopIterationStatus, LoopOnItemsAction, LoopStepOutput, LoopStepResult, StepOutputStatus } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { mockHttpServer } from './mock-http-server'
import { buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

// #387: a durable loop outlives one execution budget by pausing itself at an item boundary and
// resuming with a fresh one — and a resumed loop never sends an item twice.
describe('durable loop', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    beforeEach(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        vi.spyOn(waitpointClient, 'create').mockResolvedValue({ id: 'wp', resumeUrl: 'http://127.0.0.1:4200/api/v1/flow-runs/run/waitpoints/wp' })
        mockServer.hits.clear()
        mockServer.arrivals.length = 0
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const send: FlowAction = buildQadamAction({
        name: 'send',
        qadamName: '@aiqadam/qadam-http',
        actionName: 'send_request',
        input: {
            method: 'GET',
            url: '',
            headers: {},
            queryParams: {},
            body_type: 'none',
            body: {},
        },
    })

    const durableLoop = ({ items, concurrency = 1 }: { items: string, concurrency?: number }): LoopOnItemsAction => {
        const body = { ...send, settings: { ...send.settings, input: { ...send.settings.input, url: `${mockServer.baseUrl}/slow?ms=5&item={{loop.output.item}}` } } }
        const loop = buildSimpleLoopAction({ name: 'loop', loopItems: items, firstLoopAction: body })
        return {
            ...loop,
            settings: {
                ...loop.settings,
                collect: { value: '{{ loop.output.item }}' },
                execution: { mode: concurrency > 1 ? LoopExecutionMode.CONCURRENT : LoopExecutionMode.SEQUENTIAL, maxConcurrency: concurrency, durable: true },
            },
        }
    }

    // The budget has 1 s left, under the 5 s margin a 10 s budget gets: one item per execution.
    const nearlySpent = (): EngineConstants => generateMockEngineConstants({ stepNames: ['loop', 'send'], timeoutInSeconds: 10, executionStartedAt: Date.now() - 9_000 })
    const fresh = (): EngineConstants => generateMockEngineConstants({ stepNames: ['loop', 'send'], timeoutInSeconds: 600 })

    const readLoop = (context: FlowExecutorContext): LoopStepOutput => {
        const step = context.steps.loop
        if (step?.type !== FlowActionType.LOOP_ON_ITEMS) {
            throw new Error('loop step missing from the journal')
        }
        return new LoopStepOutput(step)
    }

    // What a RESUME hands the engine: the persisted journal, parsed back.
    const restored = async (context: FlowExecutorContext): Promise<FlowExecutorContext> => {
        const persisted: { status: StepOutputStatus, input: unknown, output: LoopStepResult } = JSON.parse(JSON.stringify(context.steps.loop))
        return FlowExecutorContext.empty().upsertStep('loop', new LoopStepOutput({ type: FlowActionType.LOOP_ON_ITEMS, ...persisted }))
    }

    it('pauses itself on a DELAY waitpoint when the budget runs low, after at least one item', async () => {
        const result = await flowExecutor.execute({ action: durableLoop({ items: '{{ [0, 1, 2, 3, 4] }}' }), executionState: FlowExecutorContext.empty(), constants: nearlySpent() })
        const loop = readLoop(result)

        expect(result.verdict.status).toBe(FlowRunStatus.PAUSED)
        expect(loop.status).toBe(StepOutputStatus.PAUSED)
        expect(loop.output?.checkpoint).toMatchObject({ count: 1, reason: LoopCheckpointReason.BUDGET, itemsCount: 5 })
        expect(loop.output?.iterationStatus).toEqual([LoopIterationStatus.SUCCEEDED])
        // A durable loop keeps only failed bodies unless told otherwise.
        expect(loop.output?.iterations[0]).toEqual({})
        expect(waitpointClient.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'DELAY', stepName: 'loop' }))
    }, 20000)

    it('resumes where it stopped and sends every item exactly once across checkpoints', async () => {
        const action = durableLoop({ items: '{{ [0, 1, 2, 3, 4, 5] }}' })
        let state = await flowExecutor.execute({ action, executionState: FlowExecutorContext.empty(), constants: nearlySpent() })
        let executions = 1
        while (state.verdict.status === FlowRunStatus.PAUSED) {
            state = await flowExecutor.execute({ action, executionState: await restored(state), constants: nearlySpent() })
            executions += 1
        }

        const loop = readLoop(state)
        expect(state.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(executions).toBe(6)
        expect(loop.output?.collected).toEqual([0, 1, 2, 3, 4, 5])
        expect(loop.output?.checkpoint?.count).toBe(5)
        expect(mockServer.arrivals).toHaveLength(6)
        expect(new Set(mockServer.arrivals.map((arrival) => arrival.path)).size).toBe(6)
    }, 30000)

    it('finishes without a checkpoint when the budget is enough', async () => {
        const result = await flowExecutor.execute({ action: durableLoop({ items: '{{ [0, 1, 2] }}', concurrency: 3 }), executionState: FlowExecutorContext.empty(), constants: fresh() })

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(readLoop(result).output?.checkpoint).toBeUndefined()
        expect(waitpointClient.create).not.toHaveBeenCalled()
    }, 20000)

    it('refuses to resume against a different list of items', async () => {
        const paused = await flowExecutor.execute({ action: durableLoop({ items: '{{ [0, 1, 2] }}' }), executionState: FlowExecutorContext.empty(), constants: nearlySpent() })

        const result = await flowExecutor.execute({ action: durableLoop({ items: '{{ [0, 1, 2, 3] }}' }), executionState: await restored(paused), constants: fresh() })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.verdict.status === FlowRunStatus.FAILED ? result.verdict.failedStep.message : '').toContain('changed while it was paused')
    }, 20000)

    it('fails clearly instead of pausing when it runs as an inline subflow', async () => {
        const constants = generateMockEngineConstants({ stepNames: ['loop', 'send'], timeoutInSeconds: 10, executionStartedAt: Date.now() - 9_000, isInlineChild: true })

        const result = await flowExecutor.execute({ action: durableLoop({ items: '{{ [0, 1, 2] }}' }), executionState: FlowExecutorContext.empty(), constants })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.verdict.status === FlowRunStatus.FAILED ? result.verdict.failedStep.message : '').toContain('Inline mode')
        expect(waitpointClient.create).not.toHaveBeenCalled()
    }, 20000)
})
