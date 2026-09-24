import { CodeAction, FlowRunStatus, isNil, QadamAction } from '@aiqadam/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import {  FlowExecutorContext } from '../handler/context/flow-execution-context'
import { stepErrorView } from './step-error-view'

// A provider asking for a longer total pause than this is not answered by holding the sandbox
// slot asleep: the step fails with the wait exposed as `error.retryAfterSeconds`, and the flow
// decides. The ceiling covers every attempt of one step together, so a step that keeps drawing
// short waits cannot sleep past it one retry at a time.
const MAX_IN_PROCESS_RETRY_SLEEP_MS = 60_000

export async function runWithExponentialBackoff<T extends CodeAction | QadamAction>({
    executionState,
    action,
    constants,
    requestFunction,
    attemptCount = 1,
    sleptMs = 0,
}: RunWithExponentialBackoffParams<T>): Promise<FlowExecutorContext> {
    const resultExecutionState = await requestFunction({ action, executionState, constants })
    const retryEnabled = action.settings.errorHandlingOptions?.retryOnFailure?.value
    if (
        executionFailedWithRetryableError(resultExecutionState) &&
        attemptCount < constants.retryConstants.maxAttempts &&
        retryEnabled &&
        isNil(constants.stepNameToTest)
    ) {
        const backoffTime = Math.pow(constants.retryConstants.retryExponential, attemptCount) * constants.retryConstants.retryInterval
        const retryAfterSeconds = stepErrorView.retryAfterSeconds({ errorMessage: resultExecutionState.getStepOutput(action.name)?.errorMessage })
        const waitTime = Math.max(backoffTime, (retryAfterSeconds ?? 0) * 1000)
        if (!isNil(retryAfterSeconds) && sleptMs + waitTime > MAX_IN_PROCESS_RETRY_SLEEP_MS) {
            return resultExecutionState
        }
        await new Promise(resolve => setTimeout(resolve, waitTime))
        return runWithExponentialBackoff({
            executionState,
            action,
            constants,
            requestFunction,
            attemptCount: attemptCount + 1,
            sleptMs: sleptMs + waitTime,
        })
    }

    return resultExecutionState
}

export async function continueIfFailureHandler(
    executionState: FlowExecutorContext,
    action: CodeAction | QadamAction,
    constants: EngineConstants,
): Promise<FlowExecutorContext> {
    const continueOnFailure = action.settings.errorHandlingOptions?.continueOnFailure?.value

    if (
        executionState.verdict.status === FlowRunStatus.FAILED &&
        continueOnFailure &&
        isNil(constants.stepNameToTest)
    ) {
        return executionState
            .setVerdict({ status: FlowRunStatus.RUNNING })
    }

    return executionState
}


const executionFailedWithRetryableError = (flowExecutorContext: FlowExecutorContext): boolean => {
    return flowExecutorContext.verdict.status === FlowRunStatus.FAILED
}

type Request<T extends CodeAction | QadamAction> = {
    action: T
    executionState: FlowExecutorContext
    constants: EngineConstants
}

type RunWithExponentialBackoffParams<T extends CodeAction | QadamAction> = {
    executionState: FlowExecutorContext
    action: T
    constants: EngineConstants
    requestFunction: RequestFunction<T>
    attemptCount?: number
    sleptMs?: number
}

type RequestFunction<T extends CodeAction | QadamAction> = (request: Request<T>) => Promise<FlowExecutorContext>

