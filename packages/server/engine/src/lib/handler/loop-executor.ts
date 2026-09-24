import { LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import { executionJournal, FlowRunStatus, isNil, LoopIterationFailure, LoopIterationStatus, LoopKeepBodies, LoopOnItemsAction, LoopStepOutput, StepOutput, StepOutputStatus } from '@aiqadam/shared'
import { sizeofUtils } from '../helper/sizeof'
import { stepErrorView } from '../helper/step-error-view'
import { utils } from '../utils'
import { BaseExecutor } from './base-executor'
import { EngineConstants } from './context/engine-constants'
import { FlowExecutorContext } from './context/flow-execution-context'
import { flowExecutor } from './flow-executor'

export const loopExecutor: BaseExecutor<LoopOnItemsAction> = {
    async handle({
        action,
        executionState,
        constants,
    }) {
        const stepStartTime = performance.now()
        const { data: resolved, error: resolveError } = await utils.tryCatchAndThrowOnEngineError(() =>
            constants.getPropsResolver(LATEST_CONTEXT_VERSION).resolve<LoopOnActionResolvedSettings>({
                unresolvedInput: {
                    items: action.settings.items,
                },
                executionState,
            }),
        )
        if (resolveError) {
            const errorMessage = utils.formatError(resolveError)
            const failedStepOutput = LoopStepOutput.init({ input: {} })
                .setStatus(StepOutputStatus.FAILED)
                .setErrorMessage(errorMessage)
                .setDuration(performance.now() - stepStartTime)
            return (await executionState.upsertStep(action.name, failedStepOutput)).setVerdict({
                status: FlowRunStatus.FAILED,
                failedStep: {
                    name: action.name,
                    displayName: action.displayName,
                    message: errorMessage,
                },
            })
        }
        const { resolvedInput, censoredInput } = resolved
        const previousStepOutput = executionState.getLoopStepOutput({ stepName: action.name })
        let stepOutput = withBookkeeping({
            stepOutput: previousStepOutput ?? LoopStepOutput.init({ input: censoredInput }),
            collecting: !isNil(action.settings.collect),
        })
        let newExecutionContext = await executionState.upsertStep(action.name, stepOutput)

        if (!Array.isArray(resolvedInput.items)) {
            const errorMessage = JSON.stringify({
                message: 'The items you have selected must be a list.',
            })
            const failedStepOutput = stepOutput
                .setStatus(StepOutputStatus.FAILED)
                .setErrorMessage(errorMessage)
                .setDuration( performance.now() - stepStartTime)
            return (await newExecutionContext.upsertStep(action.name, failedStepOutput)).setVerdict({ status: FlowRunStatus.FAILED, failedStep: {
                name: action.name,
                displayName: action.displayName,
                message: errorMessage,
            } })
        }

        const firstLoopAction = action.firstLoopAction
        // The loop owns these arrays for as long as it runs and appends to them in place: copying
        // them every iteration would make a loop quadratic again (#387). They are the same arrays
        // the journal holds, since every `LoopStepOutput` builder carries `output` across.
        const iterationStatus = stepOutput.output?.iterationStatus ?? []
        const failures = stepOutput.output?.failures ?? []
        const collected = stepOutput.output?.collected

        for (let i = 0; i < resolvedInput.items.length; ++i) {
            const newCurrentPath = newExecutionContext.currentPath.loopIteration({ loopName: action.name, iteration: i })

            const testSingleStepMode = !isNil(constants.stepNameToTest)
            stepOutput = stepOutput.setItemAndIndex({ item: resolvedInput.items[i], index: i + 1 })
            const addEmptyIteration = !stepOutput.hasIteration(i)
            if (addEmptyIteration) {
                stepOutput = stepOutput.addIteration()
            }
            newExecutionContext = (await newExecutionContext.upsertStep(action.name, stepOutput)).setCurrentPath(newCurrentPath)
            // A finished iteration is skipped without entering its body: its steps may have been
            // blanked (`keepBodies`), and a replay would otherwise run them again.
            const alreadySucceeded = iterationStatus[i] === LoopIterationStatus.SUCCEEDED
            const runsBody = !isNil(firstLoopAction) && !testSingleStepMode && !alreadySucceeded
            if (runsBody) {
                newExecutionContext = await flowExecutor.execute({
                    action: firstLoopAction,
                    executionState: newExecutionContext,
                    constants,
                })
            }
            const recordsOutcome = runsBody || (testSingleStepMode && !isNil(collected))
            if (recordsOutcome) {
                const outcome = await evaluateIteration({
                    action,
                    constants,
                    executionState: newExecutionContext,
                    iterationSteps: stepOutput.output?.iterations[i] ?? {},
                })
                if (!isNil(outcome.status)) {
                    iterationStatus[i] = outcome.status
                    const existingFailure = failures.findIndex((failure) => failure.index === i)
                    if (existingFailure !== -1) {
                        failures.splice(existingFailure, 1)
                    }
                    if (!isNil(outcome.failure)) {
                        failures.splice(sortedInsertIndex({ failures, index: i }), 0, outcome.failure)
                    }
                    if (!isNil(collected)) {
                        collected[i] = outcome.collected ?? null
                    }
                    if (!outcome.keepBody && !isNil(stepOutput.output)) {
                        stepOutput.output.iterations[i] = {}
                    }
                    newExecutionContext.recordInPlaceGrowth({ bytes: outcome.bookkeepingBytes })
                }
                newExecutionContext = outcome.executionState
            }

            newExecutionContext = newExecutionContext.setCurrentPath(newExecutionContext.currentPath.removeLast())

            if (newExecutionContext.verdict.status !== FlowRunStatus.RUNNING) {
                return newExecutionContext.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
            }

            if (testSingleStepMode) {
                break
            }
        }
        return newExecutionContext.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
    },
}

function withBookkeeping({ stepOutput, collecting }: { stepOutput: LoopStepOutput, collecting: boolean }): LoopStepOutput {
    const output = stepOutput.output
    const complete = !isNil(output?.iterationStatus) && !isNil(output?.failures) && (!collecting || !isNil(output?.collected))
    if (complete) {
        return stepOutput
    }
    return new LoopStepOutput({
        ...stepOutput,
        output: {
            item: output?.item,
            index: output?.index ?? 0,
            iterations: output?.iterations ?? [],
            ...output,
            iterationStatus: output?.iterationStatus ?? [],
            failures: output?.failures ?? [],
            ...(collecting ? { collected: output?.collected ?? [] } : {}),
        },
    })
}

// Decides what a finished iteration leaves behind. It returns the decision rather than writing
// it, so the loop's in-place bookkeeping stays in one place.
async function evaluateIteration({ action, constants, executionState, iterationSteps }: EvaluateIterationParams): Promise<IterationOutcome> {
    const verdict = executionState.verdict
    if (verdict.status === FlowRunStatus.PAUSED) {
        return { executionState, keepBody: true, bookkeepingBytes: 0 }
    }
    const hasFailedStep = !isNil(executionJournal.findLastStepWithStatus(iterationSteps, StepOutputStatus.FAILED))
    if (verdict.status !== FlowRunStatus.RUNNING) {
        const failure: LoopIterationFailure = {
            index: executionState.currentPath.path[executionState.currentPath.path.length - 1][1],
            stepName: 'failedStep' in verdict ? verdict.failedStep.name : action.name,
            description: 'failedStep' in verdict ? stepErrorView.describe({ errorMessage: verdict.failedStep.message }) : '',
        }
        return {
            executionState,
            status: LoopIterationStatus.FAILED,
            failure,
            keepBody: true,
            bookkeepingBytes: STATUS_ENTRY_BYTES + sizeofUtils.recursiveSizeof(failure) + 1 + COLLECTED_HOLE_BYTES,
        }
    }
    const collect = action.settings.collect
    const keepBody = shouldKeepBody({ keepBodies: action.settings.keepBodies, hasFailedStep })
    if (isNil(collect) || (collect.skipFailed === true && hasFailedStep)) {
        return {
            executionState,
            status: LoopIterationStatus.SUCCEEDED,
            keepBody,
            bookkeepingBytes: STATUS_ENTRY_BYTES + COLLECTED_HOLE_BYTES,
        }
    }
    const { data: resolvedCollect, error: collectError } = await utils.tryCatchAndThrowOnEngineError(() =>
        constants.getPropsResolver(LATEST_CONTEXT_VERSION).resolve<{ value: unknown }>({
            unresolvedInput: { value: collect.value },
            executionState,
        }),
    )
    if (collectError) {
        const message = `Collecting the iteration result failed: ${utils.formatError(collectError)}`
        return {
            executionState: executionState.setVerdict({
                status: FlowRunStatus.FAILED,
                failedStep: { name: action.name, displayName: action.displayName, message },
            }),
            status: LoopIterationStatus.FAILED,
            failure: {
                index: executionState.currentPath.path[executionState.currentPath.path.length - 1][1],
                stepName: action.name,
                description: message,
            },
            keepBody: true,
            bookkeepingBytes: STATUS_ENTRY_BYTES + sizeofUtils.recursiveSizeof(message) + COLLECTED_HOLE_BYTES,
        }
    }
    const value = resolvedCollect.resolvedInput.value
    return {
        executionState,
        status: LoopIterationStatus.SUCCEEDED,
        collected: value,
        keepBody,
        bookkeepingBytes: STATUS_ENTRY_BYTES + sizeofUtils.recursiveSizeof(value) + 1,
    }
}

function shouldKeepBody({ keepBodies, hasFailedStep }: { keepBodies: LoopKeepBodies | undefined, hasFailedStep: boolean }): boolean {
    switch (keepBodies) {
        case LoopKeepBodies.NONE:
            return false
        case LoopKeepBodies.FAILED_ONLY:
            return hasFailedStep
        default:
            return true
    }
}

function sortedInsertIndex({ failures, index }: { failures: LoopIterationFailure[], index: number }): number {
    const position = failures.findIndex((failure) => failure.index > index)
    return position === -1 ? failures.length : position
}

// `"S",` in `iterationStatus`, and `null,` for an iteration `collected` leaves empty.
const STATUS_ENTRY_BYTES = 4
const COLLECTED_HOLE_BYTES = 5

type LoopOnActionResolvedSettings = {
    items: readonly unknown[]
}

type EvaluateIterationParams = {
    action: LoopOnItemsAction
    constants: EngineConstants
    executionState: FlowExecutorContext
    iterationSteps: Record<string, StepOutput>
}

type IterationOutcome = {
    executionState: FlowExecutorContext
    status?: LoopIterationStatus
    failure?: LoopIterationFailure
    collected?: unknown
    keepBody: boolean
    bookkeepingBytes: number
}
