
import { BranchOperator, FlowActionType, FlowRunStatus, GenericStepOutput, RouterExecutionType, StepOutputStatus, tryParseFriendlyQadamError } from '@aiqadam/shared'
import { codeExecutor } from '../../src/lib/handler/code-executor'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { loopExecutor } from '../../src/lib/handler/loop-executor'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { routerExecuter } from '../../src/lib/handler/router-executor'
import { mockHttpServer } from './mock-http-server'
import { buildCodeAction, buildQadamAction, buildRouterWithOneCondition, buildSimpleLoopAction, generateMockEngineConstants } from './test-helper'

describe('code piece with error handling', () => {

    it('should continue on failure when execute code a code that throws an error', async () => {
        const result = await codeExecutor.handle({
            action: buildCodeAction({
                name: 'runtime',
                input: {},
                errorHandlingOptions: {
                    continueOnFailure: {
                        value: true,
                    },
                    retryOnFailure: {
                        value: false,
                    },
                },
            }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict).toStrictEqual({
            status: FlowRunStatus.RUNNING,
        })
        expect(result.steps.runtime.status).toEqual('FAILED')
        expect(result.steps.runtime.errorMessage).toContain('Custom Runtime Error')
    })

})

describe('piece with error handling', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    it('should continue on failure when piece fails', async () => {
        const result = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'send_http',
                qadamName: '@aiqadam/qadam-http',
                actionName: 'send_request',
                input: {
                    'method': 'POST',
                    'url': `${mockServer.baseUrl}/api/v1/flags`,
                    'headers': {},
                    'queryParams': {},
                    'body_type': 'none',
                    'body': {},
                },
                errorHandlingOptions: {
                    continueOnFailure: {
                        value: true,
                    },
                    retryOnFailure: {
                        value: false,
                    },
                },
            }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })

        expect(result.verdict).toStrictEqual({
            status: FlowRunStatus.RUNNING,
        })
        expect(result.steps.send_http.status).toBe('FAILED')

        const error = tryParseFriendlyQadamError(result.steps.send_http.errorMessage)
        expect(error?.status).toBe(404)
        expect(error?.errorName).toBe('HttpError')
        expect(error?.message).toBe('Route not found')
        expect(error?.apiMessage).toBe('Route not found')
        expect(error?.responseBody).toEqual({
            statusCode: 404,
            error: 'Not Found',
            message: 'Route not found',
        })

    }, 10000)

})

// #387: a flow must be able to react to a provider's rate limit with the wait it asked for, not a
// number regexed out of the JSON string that `error.message` has always been.
describe('structured step errors', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    const sendHttp = ({ path, retry }: { path: string, retry: boolean }) => buildQadamAction({
        name: 'send_http',
        qadamName: '@aiqadam/qadam-http',
        actionName: 'send_request',
        input: {
            'method': 'POST',
            'url': `${mockServer.baseUrl}${path}`,
            'headers': {},
            'queryParams': {},
            'body_type': 'none',
            'body': {},
        },
        errorHandlingOptions: {
            continueOnFailure: { value: true },
            retryOnFailure: { value: retry },
        },
    })

    it('exposes status, retryAfterSeconds, description and body next to an unchanged message', async () => {
        const result = await qadamExecutor.handle({
            action: sendHttp({ path: '/telegram-429?retryAfter=2&case=view', retry: false }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        const storedMessage = result.steps.send_http.errorMessage
        const view = await result.currentState()

        expect(view).toMatchObject({
            send_http: {
                error: {
                    message: storedMessage,
                    status: 429,
                    retryAfterSeconds: 2,
                    description: 'Too Many Requests: retry after 2',
                    body: { error_code: 429, parameters: { retry_after: 2 } },
                },
            },
        })
        expect(storedMessage).not.toContain('do-not-leak')
    }, 10000)

    it('gives an error that is not a FriendlyQadamError its string as description', async () => {
        const state = await FlowExecutorContext.empty().upsertStep('plain', GenericStepOutput.create({
            type: FlowActionType.PIECE,
            status: StepOutputStatus.FAILED,
            input: {},
        }).setErrorMessage('plain failure'))
        const view = await state.currentState()

        expect(view).toEqual({ plain: { output: undefined, error: { message: 'plain failure', description: 'plain failure' } } })
    })

    it('waits at least retryAfterSeconds before retrying', async () => {
        const startedAt = Date.now()
        const result = await qadamExecutor.handle({
            action: sendHttp({ path: '/telegram-429?retryAfter=1&recoverAfter=1&case=retry', retry: true }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.steps.send_http.status).toBe('SUCCEEDED')
        expect(mockServer.hits.get('/telegram-429?retryAfter=1&recoverAfter=1&case=retry')).toBe(2)
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000)
    }, 10000)

    it('does not sleep in-process for a wait above the in-process ceiling', async () => {
        const result = await qadamExecutor.handle({
            action: sendHttp({ path: '/telegram-429?retryAfter=120&case=ceiling', retry: true }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.steps.send_http.status).toBe('FAILED')
        expect(mockServer.hits.get('/telegram-429?retryAfter=120&case=ceiling')).toBe(1)
    }, 10000)
})

describe('action input resolution failures surface as FAILED step', () => {

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('code-executor: missing connection in input fails the step instead of throwing INTERNAL_ERROR', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))

        const result = await codeExecutor.handle({
            action: buildCodeAction({
                name: 'echo_step',
                input: {
                    storedIds: '{{connections[\'missing-conn\']}}',
                },
            }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.steps.echo_step.status).toBe('FAILED')
        expect(result.steps.echo_step.errorMessage).toContain('connection (missing-conn) not found')
    })

    it('loop-executor: missing connection in items fails the step instead of throwing INTERNAL_ERROR', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))

        const result = await loopExecutor.handle({
            action: buildSimpleLoopAction({
                name: 'loop',
                loopItems: '{{connections[\'missing-conn\']}}',
            }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.steps.loop.status).toBe('FAILED')
        expect(result.steps.loop.errorMessage).toContain('connection (missing-conn) not found')
    })

    it('router-executor: missing connection in branch condition fails the step instead of throwing INTERNAL_ERROR', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))

        const result = await routerExecuter.handle({
            action: buildRouterWithOneCondition({
                children: [null],
                conditions: [{
                    operator: BranchOperator.BOOLEAN_IS_TRUE,
                    firstValue: '{{connections[\'missing-conn\']}}',
                }],
                executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
            }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants(),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.steps.router.status).toBe('FAILED')
        expect(result.steps.router.errorMessage).toContain('connection (missing-conn) not found')
    })

})
