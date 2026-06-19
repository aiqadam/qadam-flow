import { FlowAction, FlowRunStatus, tryParseFriendlyQadamError } from '@aiqadam/shared'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { mockHttpServer } from './mock-http-server'
import { buildQadamAction, generateMockEngineConstants } from './test-helper'

describe('qadamExecutor', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    it('should execute data mapper successfully', async () => {
        const result = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'data_mapper',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: {
                    mapping: {
                        'key': '{{ 1 + 2 }}',
                    },
                },
            }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict).toStrictEqual({
            status: FlowRunStatus.RUNNING,
        })
        expect(result.steps.data_mapper.output).toEqual({ 'key': 3 })
    })

    it('should execute fail gracefully when pieces fail', async () => {
        const result = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'send_http',
                qadamName: '@aiqadam/qadam-http',
                actionName: 'send_request',
                input: {
                    'url': `${mockServer.baseUrl}/api/v1/asd`,
                    'method': 'GET',
                    'headers': {},
                    'body_type': 'none',
                    'body': {},
                    'queryParams': {},
                },
            }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })

        const verdict = result.verdict
        expect(verdict.status).toBe(FlowRunStatus.FAILED)
        if (verdict.status !== FlowRunStatus.FAILED) {
            throw new Error('Expected a FAILED verdict')
        }
        expect(verdict.failedStep.name).toBe('send_http')
        expect(verdict.failedStep.displayName).toBe('Your Action Name')

        const failedStepError = tryParseFriendlyQadamError(verdict.failedStep.message)
        expect(failedStepError?.status).toBe(404)
        expect(failedStepError?.apiMessage).toBe('Route not found')

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
    }, 30000)
    it('should skip piece action', async () => {
        const result = await flowExecutor.execute({
            action: buildQadamAction({
                name: 'data_mapper',
                input: {},
                skip: true,
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
            }), executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict).toStrictEqual({
            status: FlowRunStatus.RUNNING,
        })
        expect(result.steps.data_mapper).toBeUndefined()
    })
    it('should skip piece action in flow', async () => {
        const flow: FlowAction = {
            ...buildQadamAction({
                name: 'data_mapper',
                input: {
                    mapping: {
                        'key': '{{ 1 + 2 }}',
                    },
                },
                skip: false,
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
            }),
            nextAction: {
                ...buildQadamAction({
                    name: 'send_http',
                    qadamName: '@aiqadam/qadam-http',
                    actionName: 'send_request',
                    input: {},
                    skip: true,
                }),
                nextAction: undefined,
            },
        }
        const result = await flowExecutor.execute({
            action: flow, executionState: FlowExecutorContext.empty(), constants: generateMockEngineConstants(),
        })
        expect(result.verdict).toStrictEqual({
            status: FlowRunStatus.RUNNING,
        })
        expect(result.steps.data_mapper.output).toEqual({ 'key': 3 })
        expect(result.steps.send_http).toBeUndefined()
    })
})
