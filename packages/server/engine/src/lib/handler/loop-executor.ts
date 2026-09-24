import { createHash } from 'node:crypto'
import { LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import { executionJournal, FlowActionType, FlowRunStatus, isNil, LoopCheckpoint, LoopCheckpointReason, LoopExecutionMode, LoopExecutionSettings, LoopIterationFailure, LoopIterationFailurePolicy, LoopIterationStatus, LoopKeepBodies, LoopOnItemsAction, LoopRateLimitedPolicy, LoopStepOutput, StepOutput, StepOutputStatus, tryCatch } from '@aiqadam/shared'
import { loggingUtils } from '../helper/logging-utils'
import { LoopRateLimiter, loopRateLimiter } from '../helper/loop-rate-limiter'
import { pausedFlowLimits } from '../helper/paused-flow-limits'
import { sizeofUtils } from '../helper/sizeof'
import { stepErrorView } from '../helper/step-error-view'
import { waitpointClient } from '../qadam-context/waitpoint-client'
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
        const execution = action.settings.execution
        const durable = execution?.durable === true
        // A durable loop keeps only what a retry needs unless told otherwise: its whole point is a
        // number of items that would not fit in one run's log.
        const keepBodies = action.settings.keepBodies ?? (durable ? LoopKeepBodies.FAILED_ONLY : undefined)
        const previousCheckpoint = stepOutput.output?.checkpoint
        if (!isNil(previousCheckpoint) && (previousCheckpoint.itemsCount !== items.length || previousCheckpoint.itemsHash !== hashItems(items))) {
            // Resuming against a different list would skip or repeat items by position.
            const errorMessage = JSON.stringify({
                message: 'The items this loop was working through changed while it was paused at a checkpoint, so it cannot tell which items are done. Keep the items expression stable across a durable loop, or start a new run.',
            })
            return (await newExecutionContext.upsertStep(action.name, stepOutput.setStatus(StepOutputStatus.FAILED).setErrorMessage(errorMessage))).setVerdict({
                status: FlowRunStatus.FAILED,
                failedStep: { name: action.name, displayName: action.displayName, message: errorMessage },
            })
        }
        if (stepOutput.status === StepOutputStatus.PAUSED) {
            stepOutput = new LoopStepOutput({ ...stepOutput, status: StepOutputStatus.SUCCEEDED })
        }
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
                    const outcome = await evaluateIteration({ action, keepBodies, constants, executionState: fork, iterationSteps: stepOutput.output?.iterations[0] ?? {} })
                    recordOutcome({ index: 0, outcome })
                    newExecutionContext = newExecutionContext.setVerdict(outcome.executionState.verdict)
                }
            }
            return newExecutionContext.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
        }

        const concurrency = effectiveConcurrency({ execution, insideConcurrentIteration: newExecutionContext.isConcurrentFork })
        const concurrent = concurrency > 1
        const limiter = loopRateLimiter.create({ rateLimit: execution?.rateLimit })
        const continueOnFailure = execution?.onIterationFailure === LoopIterationFailurePolicy.CONTINUE
        // Only a loop that opted into rate handling waits on a provider: a loop authored before #387
        // fails on a 429 exactly as it did.
        const handlesRateLimits = !isNil(execution?.rateLimit) || execution?.onRateLimited === LoopRateLimitedPolicy.WAIT_AND_RETRY
        const maxRateLimitRetries = handlesRateLimits ? execution?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES : 0
        // A finished iteration is skipped without entering its body: its steps may have been
        // blanked (`keepBodies`), and a replay would otherwise run them again. A failed one is run
        // again only once its FAILED steps are gone — a FROM_FAILED_STEP retry drops them. On a
        // waitpoint resume they are kept, and replay would treat them as done and run the rest of
        // the item without them.
        const pending = items.map((_, index) => index).filter((index) => isPending({ status: iterationStatus[index], iterationSteps: stepOutput.output?.iterations[index] }))
        const rateLimitedRetries = new Map<number, number>()
        const inFlight = new Map<number, Promise<{ index: number, result: FlowExecutorContext }>>()
        const baseStepsCount = newExecutionContext.stepsCount
        let stepsExecuted = 0
        let tags: string[] = []
        let terminal: FlowVerdict | undefined
        let lastDispatched = -1
        // Only a top-level loop checkpoints: a RESUME replays from the trigger, and a loop nested in
        // another's iteration would be resumed inside an iteration its parent already counts as done.
        const canCheckpoint = durable && newExecutionContext.currentPath.path.length === 0
        let checkpointReason: LoopCheckpointReason | undefined
        let finishedThisExecution = 0

        while (pending.length > 0 || inFlight.size > 0) {
            while (isNil(terminal) && isNil(checkpointReason) && pending.length > 0 && inFlight.size < concurrency) {
                // At least one item must finish per execution, or a budget too small for one item
                // would checkpoint forever without progress.
                if (canCheckpoint && finishedThisExecution > 0) {
                    checkpointReason = checkpointNeeded({ constants, executionState: newExecutionContext, limiter })
                    if (!isNil(checkpointReason)) {
                        break
                    }
                }
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
            const { data: settled, error: iterationError } = await tryCatch(() => Promise.race(inFlight.values()))
            if (!isNil(iterationError) || isNil(settled)) {
                // An engine error in one item must not leave the others writing into the journal
                // unobserved, nor surface later as an unhandled rejection.
                await Promise.allSettled(inFlight.values())
                throw iterationError
            }
            const { index, result } = settled
            inFlight.delete(index)
            stepsExecuted += result.stepsCount - baseStepsCount
            tags = [...tags, ...result.tags]
            finishedThisExecution += 1
            const outcome = await evaluateIteration({ action, keepBodies, constants, executionState: result, iterationSteps: stepOutput.output?.iterations[index] ?? {} })

            const retryAfterSeconds = outcome.status === LoopIterationStatus.FAILED ? retryAfterOf(outcome.executionState.verdict) : undefined
            const retriesSoFar = rateLimitedRetries.get(index) ?? 0
            // A wait longer than a sandbox slot may sleep is taken paused, which only a durable loop
            // can do; otherwise the item fails with the wait on its error, as a single step does.
            const waitFitsThisExecution = !isNil(retryAfterSeconds)
                && retryAfterSeconds * 1000 <= (canCheckpoint ? MAX_DURABLE_RATE_LIMIT_WAIT_MS : MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS)
            if (!isNil(retryAfterSeconds) && waitFitsThisExecution && retriesSoFar < maxRateLimitRetries && isNil(terminal)) {
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
        if (!isNil(checkpointReason) && isNil(terminal) && pending.length > 0) {
            if (constants.isInlineChild) {
                // An inline child has no queue job of its own to resume from.
                terminal = {
                    status: FlowRunStatus.FAILED,
                    failedStep: {
                        name: action.name,
                        displayName: action.displayName,
                        message: JSON.stringify({ message: 'This durable loop needs a checkpoint to continue, which a subflow called in Inline mode cannot take. Call the subflow in Queue mode.' }),
                    },
                }
            }
            else {
                stepOutput = await takeCheckpoint({ action, constants, stepOutput, reason: checkpointReason, items, limiter })
                terminal = { status: FlowRunStatus.PAUSED }
            }
        }
        newExecutionContext.clearLoopItems({ loopName: action.name })
        const merged = newExecutionContext
            .addTags(tags)
            .addStepsExecuted(stepsExecuted)
            .setVerdict(terminal ?? continueVerdict({ action, continueOnFailure, tolerateFailures: execution?.tolerateFailures === true, failures, total: items.length }))
        return merged.upsertStep(action.name, stepOutput.setDuration(performance.now() - stepStartTime))
    },
}

// The operator's ceiling (`AP_LOOP_MAX_CONCURRENCY`) wins over what a flow asks for: a loop runs
// inside one sandbox, and every iteration in flight holds its memory and its outbound sockets.
function effectiveConcurrency({ execution, insideConcurrentIteration }: { execution: LoopExecutionSettings | undefined, insideConcurrentIteration: boolean }): number {
    // A concurrent loop inside a concurrent iteration runs its items one at a time: the operator
    // ceiling bounds one run's iterations in flight, and nesting would multiply it.
    if (execution?.mode !== LoopExecutionMode.CONCURRENT || insideConcurrentIteration) {
        return 1
    }
    return Math.max(1, Math.min(execution.maxConcurrency ?? OPERATOR_MAX_CONCURRENCY, OPERATOR_MAX_CONCURRENCY))
}

// Checked before each new item starts, never mid-item: the checkpoint lands on an iteration
// boundary once the items already running have finished.
function checkpointNeeded({ constants, executionState, limiter }: CheckpointNeededParams): LoopCheckpointReason | undefined {
    const budgetMs = constants.timeoutInSeconds * 1000
    const marginMs = Math.min(Math.max(CHECKPOINT_MIN_MARGIN_MS, budgetMs * CHECKPOINT_MARGIN_FRACTION), budgetMs / 2)
    if (budgetMs - (Date.now() - constants.executionStartedAt) < marginMs) {
        return LoopCheckpointReason.BUDGET
    }
    if (!loggingUtils.isWithinCheckpointLimit(executionState.steps)) {
        return LoopCheckpointReason.LOG_SIZE
    }
    if (limiter.msUntilNextStart() > MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS) {
        return LoopCheckpointReason.RATE_LIMIT
    }
    return undefined
}

// The loop pauses itself on a DELAY waitpoint under its own step name, so the existing resume path
// brings it back with a fresh execution budget; a replay skips every finished item.
async function takeCheckpoint({ action, constants, stepOutput, reason, items, limiter }: TakeCheckpointParams): Promise<LoopStepOutput> {
    const waitMs = reason === LoopCheckpointReason.RATE_LIMIT ? limiter.msUntilNextStart() : 0
    const resumeDateTime = new Date(Date.now() + waitMs).toISOString()
    pausedFlowLimits.assertResumeWithinTimeout(resumeDateTime)
    await waitpointClient.create({
        apiUrl: constants.internalApiUrl,
        engineToken: constants.engineToken,
        flowRunId: constants.flowRunId,
        projectId: constants.projectId,
        stepName: action.name,
        type: 'DELAY',
        version: 'V1',
        resumeDateTime,
        workerHandlerId: constants.workerHandlerId ?? undefined,
        httpRequestId: constants.httpRequestId ?? undefined,
    })
    const checkpoint: LoopCheckpoint = {
        count: (stepOutput.output?.checkpoint?.count ?? 0) + 1,
        lastAt: new Date().toISOString(),
        reason,
        itemsCount: items.length,
        itemsHash: hashItems(items),
    }
    return new LoopStepOutput({
        ...stepOutput,
        status: StepOutputStatus.PAUSED,
        output: { item: stepOutput.output?.item, index: stepOutput.output?.index ?? 0, iterations: stepOutput.output?.iterations ?? [], ...stepOutput.output, checkpoint },
    })
}

function hashItems(items: readonly unknown[]): string {
    return createHash('sha256').update(JSON.stringify(items)).digest('hex')
}

function isPending({ status, iterationSteps }: { status: LoopIterationStatus | undefined, iterationSteps: Record<string, StepOutput> | undefined }): boolean {
    if (status === LoopIterationStatus.SUCCEEDED) {
        return false
    }
    if (status === LoopIterationStatus.FAILED) {
        return isNil(executionJournal.findLastStepWithStatus(iterationSteps ?? {}, StepOutputStatus.FAILED))
    }
    return true
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
async function evaluateIteration({ action, keepBodies, constants, executionState, iterationSteps }: EvaluateIterationParams): Promise<IterationOutcome> {
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
    const keepBody = shouldKeepBody({ keepBodies, hasFailedStep })
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
// A durable loop pauses with at least this much of its budget left, but never more than half of it.
const CHECKPOINT_MIN_MARGIN_MS = 60_000
const CHECKPOINT_MARGIN_FRACTION = 0.1
// A provider wait longer than this is spent paused, not asleep in a sandbox slot.
const MAX_IN_PROCESS_RATE_LIMIT_WAIT_MS = 60_000
// A provider cannot park a durable loop longer than this; past it the item fails with the wait on
// its error, and the flow decides.
const MAX_DURABLE_RATE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1000
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

type CheckpointNeededParams = {
    constants: EngineConstants
    executionState: FlowExecutorContext
    limiter: LoopRateLimiter
}

type TakeCheckpointParams = {
    action: LoopOnItemsAction
    constants: EngineConstants
    stepOutput: LoopStepOutput
    reason: LoopCheckpointReason
    items: readonly unknown[]
    limiter: LoopRateLimiter
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
    keepBodies: LoopKeepBodies | undefined
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
