import { FlowAction, FlowActionType, FlowRunStatus, LoopExecutionMode, LoopExecutionSettings, LoopIterationFailurePolicy, LoopIterationStatus, LoopOnItemsAction, LoopRateLimitedPolicy, LoopStepOutput, LoopStepResult, StepOutputStatus } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { mockHttpServer } from './mock-http-server'
import { buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

// #387 / #374: a loop can run its iterations concurrently, paced to a declared rate, pausing every
// iteration when a provider answers with a wait.
describe('concurrent loop', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    beforeEach(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        mockServer.hits.clear()
        mockServer.arrivals.length = 0
        mockServer.concurrency.max = 0
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const request = ({ path, continueOnFailure = false }: { path: string, continueOnFailure?: boolean }): FlowAction => buildQadamAction({
        name: 'send',
        qadamName: '@aiqadam/qadam-http',
        actionName: 'send_request',
        input: {
            method: 'GET',
            url: `${mockServer.baseUrl}${path}`,
            headers: {},
            queryParams: {},
            body_type: 'none',
            body: {},
        },
        errorHandlingOptions: { continueOnFailure: { value: continueOnFailure }, retryOnFailure: { value: false } },
    })

    const loopOf = ({ count, execution, body, collect = '{{ loop.output.item }}' }: { count: number, execution: LoopExecutionSettings, body: FlowAction, collect?: string }): LoopOnItemsAction => {
        const loop = buildSimpleLoopAction({ name: 'loop', loopItems: `{{ Array.from({ length: ${count} }, (_, i) => i) }}`, firstLoopAction: body })
        return { ...loop, settings: { ...loop.settings, collect: { value: collect }, execution } }
    }

    const run = async (action: FlowAction): Promise<{ result: FlowExecutorContext, loop: LoopStepResult | undefined, elapsedMs: number }> => {
        const startedAt = Date.now()
        const result = await flowExecutor.execute({
            action,
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['loop', 'send'] }),
        })
        const step = result.steps.loop
        return { result, loop: step?.type === FlowActionType.LOOP_ON_ITEMS ? step.output : undefined, elapsedMs: Date.now() - startedAt }
    }

    it('keeps at most maxConcurrency iterations in flight, and each reads its own item', async () => {
        const { result, loop, elapsedMs } = await run(loopOf({
            count: 10,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 5 },
            body: request({ path: '/slow?ms=200&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(mockServer.concurrency.max).toBe(5)
        expect(elapsedMs).toBeLessThan(1500)
        expect(loop?.collected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(new Set(mockServer.arrivals.map((arrival) => arrival.path)).size).toBe(10)
        expect(result.stepsCount).toBe(10)
        expect(loop?.item).toBe(9)
    }, 20000)

    it('runs one iteration at a time when SEQUENTIAL', async () => {
        await run(loopOf({ count: 3, execution: { mode: LoopExecutionMode.SEQUENTIAL }, body: request({ path: '/slow?ms=50&item={{loop.output.item}}' }) }))

        expect(mockServer.concurrency.max).toBe(1)
    }, 20000)

    it('starts iterations no faster than the declared rate', async () => {
        const { result } = await run(loopOf({
            count: 6,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 6, rateLimit: { count: 10, perSeconds: 1 } },
            body: request({ path: '/slow?ms=10&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        const starts = mockServer.arrivals.map((arrival) => arrival.at).sort((a, b) => a - b)
        const gaps = starts.slice(1).map((at, i) => at - starts[i])
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(90)
    }, 20000)

    it('pauses every iteration for the retry-after a provider asked for, and retries the one it answered', async () => {
        const { result, loop, elapsedMs } = await run(loopOf({
            count: 4,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 2, onRateLimited: LoopRateLimitedPolicy.WAIT_AND_RETRY },
            body: request({ path: '/telegram-429?retryAfter=1&recoverAfter={{ loop.output.item === 0 ? 1 : 0 }}&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loop?.failures).toEqual([])
        expect(loop?.collected).toEqual([0, 1, 2, 3])
        expect(mockServer.hits.get('/telegram-429?retryAfter=1&recoverAfter=1&item=0')).toBe(2)
        expect(elapsedMs).toBeGreaterThanOrEqual(1000)
    }, 20000)

    it('with CONTINUE tries every item and fails the run once, listing the failures', async () => {
        const { result, loop } = await run(loopOf({
            count: 4,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 4, onIterationFailure: LoopIterationFailurePolicy.CONTINUE },
            body: request({ path: '{{ loop.output.item % 2 === 0 ? `/slow?ms=10&item=${loop.output.item}` : `/missing/${loop.output.item}` }}' }),
        }))

        expect(loop?.failures?.map((failure) => failure.index)).toEqual([1, 3])
        expect(loop?.collected).toEqual([0, null, 2, null])
        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.verdict.status === FlowRunStatus.FAILED ? JSON.parse(result.verdict.failedStep.message ?? '{}') : {}).toMatchObject({ failedCount: 2, total: 4 })
    }, 20000)

    it('with CONTINUE and tolerateFailures lets the flow carry on', async () => {
        const { result, loop } = await run(loopOf({
            count: 2,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 2, onIterationFailure: LoopIterationFailurePolicy.CONTINUE, tolerateFailures: true },
            body: request({ path: '/missing/{{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loop?.failures).toHaveLength(2)
    }, 20000)

    it('refuses a step that would pause inside a CONCURRENT iteration, before any waitpoint exists', async () => {
        const delay = buildQadamAction({
            name: 'send',
            qadamName: '@aiqadam/qadam-delay',
            actionName: 'delayFor',
            input: { unit: 'seconds', delayFor: 60 },
        })
        const createWaitpoint = vi.spyOn(waitpointClient, 'create')
        const { result, loop } = await run(loopOf({ count: 2, execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 2 }, body: delay }))

        expect(createWaitpoint).not.toHaveBeenCalled()
        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(loop?.failures?.[0]?.description).toContain('CONCURRENT loop')
    }, 20000)

    // Only a loop that opted into rate handling waits on a provider; one authored before #387 fails
    // on a 429 as it always did.
    it('does not retry a rate-limited item when the loop did not ask for rate handling', async () => {
        const { result } = await run(loopOf({
            count: 1,
            execution: { mode: LoopExecutionMode.SEQUENTIAL },
            body: request({ path: '/telegram-429?retryAfter=1&recoverAfter=1&case=plain&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(mockServer.hits.get('/telegram-429?retryAfter=1&recoverAfter=1&case=plain&item=0')).toBe(1)
    }, 20000)

    it('retries a rate-limited item in a SEQUENTIAL loop that asked for it', async () => {
        const { result, loop } = await run(loopOf({
            count: 1,
            execution: { mode: LoopExecutionMode.SEQUENTIAL, onRateLimited: LoopRateLimitedPolicy.WAIT_AND_RETRY },
            body: request({ path: '/telegram-429?retryAfter=1&recoverAfter=1&case=sequential&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(loop?.collected).toEqual([0])
        expect(mockServer.hits.get('/telegram-429?retryAfter=1&recoverAfter=1&case=sequential&item=0')).toBe(2)
    }, 20000)

    it('fails an item at once when the wait a provider asks for would outlast the sandbox slot', async () => {
        const { result, elapsedMs } = await run(loopOf({
            count: 1,
            execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 2, onRateLimited: LoopRateLimitedPolicy.WAIT_AND_RETRY },
            body: request({ path: '/telegram-429?retryAfter=9999999&case=huge&item={{loop.output.item}}' }),
        }))

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(elapsedMs).toBeLessThan(5000)
    }, 20000)

    it('runs a CONCURRENT loop nested in a concurrent iteration one item at a time', async () => {
        const innerBase = buildSimpleLoopAction({ name: 'inner', loopItems: '{{ [0, 1, 2] }}', firstLoopAction: request({ path: '/slow?ms=100&outer={{loop.output.item}}&inner={{inner.output.item}}' }) })
        const inner: LoopOnItemsAction = { ...innerBase, settings: { ...innerBase.settings, execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 3 } } }
        const outerBase = buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [0, 1] }}', firstLoopAction: inner })
        const outer: LoopOnItemsAction = { ...outerBase, settings: { ...outerBase.settings, execution: { mode: LoopExecutionMode.CONCURRENT, maxConcurrency: 2 } } }

        const result = await flowExecutor.execute({ action: outer, executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants({ stepNames: ['loop', 'inner', 'send'] }) })

        expect(result.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(mockServer.concurrency.max).toBe(2)
        expect(mockServer.arrivals).toHaveLength(6)
    }, 20000)

    // A waitpoint resume keeps FAILED steps, and replay treats them as done: re-entering a failed
    // item would run the rest of it without the failed step and record it as succeeded.
    it('does not re-enter an already failed item when a paused run resumes', async () => {
        const restoredState = await FlowExecutorContext.empty().upsertStep('loop', new LoopStepOutput({
            type: FlowActionType.LOOP_ON_ITEMS,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: {
                item: 0,
                index: 1,
                iterations: [{ send: { type: FlowActionType.PIECE, status: StepOutputStatus.FAILED, input: {}, errorMessage: 'boom' } }],
                iterationStatus: [LoopIterationStatus.FAILED],
                failures: [{ index: 0, stepName: 'send', description: 'boom' }],
                collected: [null],
            },
        }))

        const result = await flowExecutor.execute({
            action: loopOf({
                count: 2,
                execution: { mode: LoopExecutionMode.SEQUENTIAL, onIterationFailure: LoopIterationFailurePolicy.CONTINUE, tolerateFailures: true },
                body: request({ path: '/slow?ms=5&case=resume&item={{loop.output.item}}' }),
            }),
            executionState: restoredState,
            constants: generateMockEngineConstants({ stepNames: ['loop', 'send'] }),
        })
        const step = result.steps.loop
        const loop = step?.type === FlowActionType.LOOP_ON_ITEMS ? step.output : undefined

        expect(mockServer.hits.get('/slow?ms=5&case=resume&item=0')).toBeUndefined()
        expect(mockServer.hits.get('/slow?ms=5&case=resume&item=1')).toBe(1)
        expect(loop?.iterationStatus).toEqual([LoopIterationStatus.FAILED, LoopIterationStatus.SUCCEEDED])
        expect(loop?.failures?.map((failure) => failure.index)).toEqual([0])
    }, 20000)
})
