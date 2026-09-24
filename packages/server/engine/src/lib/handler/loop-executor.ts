import { LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import { executionJournal, FlowActionType, FlowRunStatus, isNil, LoopExecutionMode, LoopExecutionSettings, LoopIterationFailure, LoopIterationFailurePolicy, LoopIterationStatus, LoopKeepBodies, LoopOnItemsAction, LoopRateLimitedPolicy, LoopStepOutput, StepOutput, StepOutputStatus } from '@aiqadam/shared'
import { loopRateLimiter } from '../helper/loop-rate-limiter'
import { sizeofUtils } from '../helper/sizeof'
import { stepErrorView } from '../helper/step-error-view'
import { utils } from '../utils'
import { BaseExecutor } from './base-executor'
import { EngineConstants } from './context/engine-constants'
import { FlowExecutorContext, FlowVerdict } from './context/flow-execution-context'
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
        const items = resolvedInput.items
        newExecutionContext.setLoopItems({ loopName: action.name, items })
        // The loop owns these arrays for as long as it runs and appends to them in place: copying
        // them every iteration would make a loop quadratic again (#387). They are the same arrays
        // the journal holds, since every `LoopStepOutput` builder carries `output` across.
        const iterationStatus = stepOutput.output?.iterationStatus ?? []
        const failures = stepOutput.output?.failures ?? []
        const collected = stepOutput.output?.collected

        const recordOutcome = ({ index, outcome }: { index: number, outcome: IterationOutcome }): void => {
            if (isNil(outcome.status)) {
                return
            }
            iterationStatus[index] = outcome.status
            const existingFailure = failures.findIndex((failure) => failure.index === index)
            if (existingFailure !== -1) {
                failures.splice(existingFailure, 1)
            }
            if (!isNil(outcome.failure)) {
                failures.splice(sortedInsertIndex({ failures, index }), 0, outcome.failure)
            }
            if (!isNil(collected)) {
                collected[index] = outcome.collected ?? null
            }
            if (!outcome.keepBody && !isNil(stepOutput.output)) {
                stepOutput.output.iterations[index] = {}
            }
            newExecutionContext.recordInPlaceGrowth({ bytes: outcome.bookkeepingBytes })
        }

        const withIterationSlot = async (index: number): Promise<void> => {
            stepOutput = stepOutput.setItemAndIndex({ item: items[index], index: index + 1 })
            while (!stepOutput.hasIteration(index)) {
                stepOutput = stepOutput.addIteration()
            }
            newExecutionContext = await newExecutionContext.upsertStep(action.name, stepOutput)
        }

        if (!isNil(constants.stepNameToTest)) {
            if (items.length > 0) {
                await withIterationSlot(0)
                if (!isNil(collected)) {
                    const fork = newExecutionContext.forkForIteration({ loopName: action.name, iteration: 0, concurrent: false })
                    const outcome = await evaluateIteration({ action, constants, executionState: fork, iterationSteps: stepOutput.output?.iterations[0] ?? {} })
                    recordOutcome({ index: 0, outcome })
                    newExecutionContext = newExecutionContext.setVerdict(outcome.executionState.verdict)
                }
            }
            return newExecutionContext.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
        }

        const execution = action.settings.execution
        const concurrency = effectiveConcurrency(execution)
        const concurrent = concurrency > 1
        const limiter = loopRateLimiter.create({ rateLimit: execution?.rateLimit })
        const continueOnFailure = execution?.onIterationFailure === LoopIterationFailurePolicy.CONTINUE
        const maxRateLimitRetries = execution?.onRateLimited === LoopRateLimitedPolicy.FAIL ? 0 : execution?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES
        // A finished iteration is skipped without entering its body: its steps may have been
        // blanked (`keepBodies`), and a replay would otherwise run them again.
        const pending = items.map((_, index) => index).filter((index) => iterationStatus[index] !== LoopIterationStatus.SUCCEEDED)
        const rateLimitedRetries = new Map<number, number>()
        const inFlight = new Map<number, Promise<{ index: number, result: FlowExecutorContext }>>()
        const baseStepsCount = newExecutionContext.stepsCount
        let stepsExecuted = 0
        let tags: string[] = []
        let terminal: FlowVerdict | undefined
        let lastDispatched = -1

        while (pending.length > 0 || inFlight.size > 0) {
            while (isNil(terminal) && pending.length > 0 && inFlight.size < concurrency) {
                const index = pending.shift() ?? 0
                await limiter.acquire()
                await withIterationSlot(index)
                lastDispatched = Math.max(lastDispatched, index)
                const fork = newExecutionContext.forkForIteration({ loopName: action.name, iteration: index, concurrent })
                const running = isNil(firstLoopAction)
                    ? Promise.resolve(fork)
                    : flowExecutor.execute({ action: firstLoopAction, executionState: fork, constants })
                inFlight.set(index, running.then((result) => ({ index, result })))
            }
            if (inFlight.size === 0) {
                break
            }
            const { index, result } = await Promise.race(inFlight.values())
            inFlight.delete(index)
            stepsExecuted += result.stepsCount - baseStepsCount
            tags = [...tags, ...result.tags]
            const outcome = await evaluateIteration({ action, constants, executionState: result, iterationSteps: stepOutput.output?.iterations[index] ?? {} })

            const retryAfterSeconds = outcome.status === LoopIterationStatus.FAILED ? retryAfterOf(outcome.executionState.verdict) : undefined
            const retriesSoFar = rateLimitedRetries.get(index) ?? 0
            if (!isNil(retryAfterSeconds) && retriesSoFar < maxRateLimitRetries && isNil(terminal)) {
                rateLimitedRetries.set(index, retriesSoFar + 1)
                limiter.pause({ seconds: retryAfterSeconds })
                // A FAILED step counts as completed on replay (`isCompleted` only skips PAUSED), so it
                // is dropped — as a FROM_FAILED_STEP retry drops it — for the retry to run it again.
                // The iteration's steps that succeeded stay, and are not repeated.
                dropFailedSteps(stepOutput.output?.iterations[index] ?? {})
                pending.unshift(index)
                continue
            }
            recordOutcome({ index, outcome })
            const verdict = outcome.executionState.verdict
            const endsTheLoop = verdict.status !== FlowRunStatus.RUNNING && !(continueOnFailure && verdict.status === FlowRunStatus.FAILED)
            if (endsTheLoop && verdictPriority(verdict) > verdictPriority(terminal)) {
                terminal = verdict
            }
        }

        if (lastDispatched >= 0) {
            stepOutput = stepOutput.setItemAndIndex({ item: items[lastDispatched], index: lastDispatched + 1 })
        }
        const merged = newExecutionContext
            .addTags(tags)
            .addStepsExecuted(stepsExecuted)
            .setVerdict(terminal ?? continueVerdict({ action, continueOnFailure, tolerateFailures: execution?.tolerateFailures === true, failures, total: items.length }))
        return merged.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
    },
}

// The operator's ceiling (`AP_LOOP_MAX_CONCURRENCY`) wins over what a flow asks for: a loop runs
// inside one sandbox, and every iteration in flight holds its memory and its outbound sockets.
function effectiveConcurrency(execution: LoopExecutionSettings | undefined): number {
    if (execution?.mode !== LoopExecutionMode.CONCURRENT) {
        return 1
    }
    return Math.max(1, Math.min(execution.maxConcurrency ?? OPERATOR_MAX_CONCURRENCY, OPERATOR_MAX_CONCURRENCY))
}

function dropFailedSteps(steps: Record<string, StepOutput>): void {
    for (const [stepName, step] of Object.entries(steps)) {
        if (step.status === StepOutputStatus.FAILED) {
            Reflect.deleteProperty(steps, stepName)
            continue
        }
        if (step.type === FlowActionType.LOOP_ON_ITEMS) {
            for (const iteration of step.output?.iterations ?? []) {
                dropFailedSteps(iteration)
            }
        }
    }
}

function retryAfterOf(verdict: FlowVerdict): number | undefined {
    if (verdict.status !== FlowRunStatus.FAILED) {
        return undefined
    }
    return stepErrorView.retryAfterSeconds({ errorMessage: verdict.failedStep.message })
}

// The run's verdict out of several iterations: a log that outgrew its cap outranks a failure, which
// outranks a step that stopped the flow, which outranks a pause.
function verdictPriority(verdict: FlowVerdict | undefined): number {
    switch (verdict?.status) {
        case FlowRunStatus.LOG_SIZE_EXCEEDED:
            return 4
        case FlowRunStatus.FAILED:
            return 3
        case FlowRunStatus.SUCCEEDED:
            return 2
        case FlowRunStatus.PAUSED:
            return 1
        default:
            return 0
    }
}

// Under CONTINUE a run whose iterations failed still fails once every item was tried, so alerts
// fire; `tolerateFailures` is the explicit opt-out for a flow that reports failures itself.
function continueVerdict({ action, continueOnFailure, tolerateFailures, failures, total }: ContinueVerdictParams): FlowVerdict {
    if (!continueOnFailure || tolerateFailures || failures.length === 0) {
        return { status: FlowRunStatus.RUNNING }
    }
    const first = failures[0]
    return {
        status: FlowRunStatus.FAILED,
        failedStep: {
            name: action.name,
            displayName: action.displayName,
            message: JSON.stringify({
                message: `${failures.length} of ${total} items failed`,
                failedCount: failures.length,
                total,
                firstFailure: first,
            }),
        },
    }
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
    // A step that stopped the flow (`run.stop`) ends it successfully; only a failure is one.
    const iterationFailed = verdict.status !== FlowRunStatus.RUNNING && verdict.status !== FlowRunStatus.SUCCEEDED
    if (iterationFailed) {
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
        const failure: LoopIterationFailure = {
            index: executionState.currentPath.path[executionState.currentPath.path.length - 1][1],
            stepName: action.name,
            description: message,
        }
        return {
            executionState: executionState.setVerdict({
                status: FlowRunStatus.FAILED,
                failedStep: { name: action.name, displayName: action.displayName, message },
            }),
            status: LoopIterationStatus.FAILED,
            failure,
            keepBody: true,
            bookkeepingBytes: STATUS_ENTRY_BYTES + sizeofUtils.recursiveSizeof(failure) + 1 + COLLECTED_HOLE_BYTES,
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

const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5
const DEFAULT_OPERATOR_MAX_CONCURRENCY = 10
const OPERATOR_MAX_CONCURRENCY = readOperatorMaxConcurrency()

function readOperatorMaxConcurrency(): number {
    const configured = Number(process.env.AP_LOOP_MAX_CONCURRENCY)
    return Number.isInteger(configured) && configured >= 1 ? configured : DEFAULT_OPERATOR_MAX_CONCURRENCY
}

// `"S",` in `iterationStatus`, and `null,` for an iteration `collected` leaves empty.
const STATUS_ENTRY_BYTES = 4
const COLLECTED_HOLE_BYTES = 5

type LoopOnActionResolvedSettings = {
    items: readonly unknown[]
}

type ContinueVerdictParams = {
    action: LoopOnItemsAction
    continueOnFailure: boolean
    tolerateFailures: boolean
    failures: LoopIterationFailure[]
    total: number
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
