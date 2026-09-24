import { FlowActionType, FlowRunStatus, GenericStepOutput, StepOutputStatus } from '@aiqadam/shared'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { runWithExponentialBackoff } from '../../src/lib/helper/error-handling'
import { buildCodeAction, generateMockEngineConstants } from '../handler/test-helper'

describe('runWithExponentialBackoff', () => {
    const executionState = FlowExecutorContext.empty()
    const action = buildCodeAction({
        name: 'runtime',
        input: {},
        errorHandlingOptions: {
            continueOnFailure: {
                value: false,
            },
            retryOnFailure: {
                value: true,
            },
        },
    })
    const constants = generateMockEngineConstants()
    const requestFunction = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterAll(() => {
        vi.clearAllMocks()
    })

    it('should return resultExecutionState when verdict is not FAILED', async () => {
        const resultExecutionState = FlowExecutorContext.empty().setVerdict({
            status: FlowRunStatus.SUCCEEDED,
            stopResponse: undefined,
        })
        requestFunction.mockResolvedValue(resultExecutionState)

        const output = await runWithExponentialBackoff({ executionState, action, constants, requestFunction })

        expect(output).toEqual(resultExecutionState)
        expect(requestFunction).toHaveBeenCalledWith({ action, executionState, constants })
    })


    it('should retry and return resultExecutionState when verdict is FAILED and retry is enabled', async () => {
        const resultExecutionState = FlowExecutorContext.empty().setVerdict({
            status: FlowRunStatus.FAILED,
            failedStep: {
                name: 'runtime',
                displayName: 'runtime',
                message: 'Custom Runtime Error',
            },
        })

        requestFunction.mockResolvedValue(resultExecutionState)

        const output = await runWithExponentialBackoff({ executionState, action, constants, requestFunction })

        expect(output).toEqual(resultExecutionState)
        // Mock applies for the first attempt and second attempt is a real call which return success
        expect(requestFunction).toHaveBeenCalledTimes(2)
        expect(requestFunction).toHaveBeenCalledWith({ action, executionState, constants })
        expect(requestFunction).toHaveBeenCalledWith({ action, executionState, constants })
    })

    it('should not retry and return resultExecutionState when verdict is FAILED but retry is disabled', async () => {
        const resultExecutionState = FlowExecutorContext.empty().setVerdict({
            status: FlowRunStatus.FAILED,
            failedStep: {
                name: 'runtime',
                displayName: 'runtime',
                message: 'Custom Runtime Error',
            },
        })

        requestFunction.mockResolvedValue(resultExecutionState)


        const actionWithDisabledRetry = buildCodeAction({
            name: 'runtime',
            input: {},
            errorHandlingOptions: {
                continueOnFailure: {
                    value: false,
                },
                retryOnFailure: {
                    value: false,
                },
            },
        })

        const output = await runWithExponentialBackoff({ executionState, action: actionWithDisabledRetry, constants, requestFunction })

        expect(output).toEqual(resultExecutionState)
        expect(requestFunction).toHaveBeenCalledTimes(1)
        expect(requestFunction).toHaveBeenCalledWith({ action: actionWithDisabledRetry, executionState, constants })

    })


    // #387: the in-process ceiling is on the total a step sleeps across its retries, so two
    // 31-second waits are not taken one after the other.
    it('stops retrying once the waits a provider asked for would exceed the ceiling together', async () => {
        vi.useFakeTimers()
        try {
            const failedWithRetryAfter = await FlowExecutorContext.empty().upsertStep('runtime', GenericStepOutput.create({
                type: FlowActionType.CODE,
                status: StepOutputStatus.FAILED,
                input: {},
            }).setErrorMessage(JSON.stringify({ __apErrorVersion: 1, message: 'Too Many Requests', status: 429, retryAfterSeconds: 31 })))
            const failed = failedWithRetryAfter.setVerdict({
                status: FlowRunStatus.FAILED,
                failedStep: { name: 'runtime', displayName: 'runtime', message: 'Too Many Requests' },
            })
            requestFunction.mockResolvedValue(failed)

            const pending = runWithExponentialBackoff({
                executionState,
                action,
                constants: generateMockEngineConstants({ retryConstants: { maxAttempts: 4, retryExponential: 1, retryInterval: 1 } }),
                requestFunction,
            })
            await vi.advanceTimersByTimeAsync(31_000)
            const output = await pending

            expect(output).toBe(failed)
            expect(requestFunction).toHaveBeenCalledTimes(2)
        }
        finally {
            vi.useRealTimers()
        }
    })
})