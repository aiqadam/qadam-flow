import {
    apId,
    assertEqual,
    BaseStepOutput,
    EngineGenericError,
    executionJournal,
    FailedStep,
    FileType,
    FlowActionType,
    FlowRunStatus,
    GenericStepOutput,
    isNil,
    LogSliceRef,
    LoopStepOutput,
    LoopStepResult,
    RespondResponse,
    StepOutput,
    StepOutputStatus,
    StepOutputType,
} from '@aiqadam/shared'
import { engineFileApi } from '../../engine-file-api'
import { logRedaction, StepLogPolicy } from '../../helper/log-redaction'
import { loggingUtils } from '../../helper/logging-utils'
import { StepErrorView, stepErrorView } from '../../helper/step-error-view'
import { utils } from '../../utils'
import { StepExecutionPath } from './step-execution-path'

const DEFAULT_THRESHOLD_KB = 32
const SLICE_THRESHOLD_BYTES = Number(
    process.env.AP_FLOW_RUN_LOG_SLICE_THRESHOLD_KB ?? DEFAULT_THRESHOLD_KB,
) * 1024

export class FlowExecutorContext {
    tags: readonly string[]
    steps: Readonly<Record<string, StepOutput>>
    verdict: FlowVerdict
    currentPath: StepExecutionPath
    stepNameToTest?: boolean
    stepsCount: number
    engineApi?: EngineApiConfig
    resolvedStepOutputCache: Map<string, Promise<unknown>>
    errorViewCache: Map<string, StepErrorView>
    slicingEnabled: boolean
    stepLogPolicy: Map<string, StepLogPolicy>
    // The items each running loop iterates over, shared by every copy of this context like the
    // journal. A loop's `item`/`index` used to be read off its one shared output, which is only
    // right while a single iteration runs at a time (#387): an iteration now reads its own item by
    // its path.
    loopItems: Map<string, readonly unknown[]>
    // Set on the context an iteration of a CONCURRENT loop runs in: such an iteration cannot pause.
    isConcurrentFork: boolean
    // Set on the context any loop iteration runs in: its verdict is the iteration's, not the run's,
    // so it is never reported to the server as the run's status.
    isIterationFork: boolean

    /**
     * Execution time in milliseconds
     */
    duration: number

    constructor(copyFrom?: Partial<FlowExecutorContext>) {
        this.tags = copyFrom?.tags ?? []
        this.steps = copyFrom?.steps ?? {}
        this.duration = copyFrom?.duration ?? -1
        this.verdict = copyFrom?.verdict ?? { status: FlowRunStatus.RUNNING }
        this.currentPath = copyFrom?.currentPath ?? StepExecutionPath.empty()
        this.stepNameToTest = copyFrom?.stepNameToTest ?? false
        this.stepsCount = copyFrom?.stepsCount ?? 0
        this.engineApi = copyFrom?.engineApi
        this.resolvedStepOutputCache  = copyFrom?.resolvedStepOutputCache  ?? new Map()
        this.errorViewCache = copyFrom?.errorViewCache ?? new Map()
        this.slicingEnabled = copyFrom?.slicingEnabled ?? true
        this.stepLogPolicy = copyFrom?.stepLogPolicy ?? new Map()
        this.loopItems = copyFrom?.loopItems ?? new Map()
        this.isConcurrentFork = copyFrom?.isConcurrentFork ?? false
        this.isIterationFork = copyFrom?.isIterationFork ?? false
    }

    static empty(params?: FlowExecutorContextInit): FlowExecutorContext {
        return new FlowExecutorContext({ engineApi: params?.engineApi, slicingEnabled: params?.slicingEnabled, stepLogPolicy: params?.stepLogPolicy })
    }

    public finishExecution(): FlowExecutorContext {
        if (this.verdict.status === FlowRunStatus.RUNNING) {
            return new FlowExecutorContext({
                ...this,
                verdict: { status: FlowRunStatus.SUCCEEDED },
            })
        }
        return this
    }

    public getLoopStepOutput({ stepName }: { stepName: string }): LoopStepOutput | undefined {
        const stateAtPath = executionJournal.getStateAtPath({ path: this.currentPath.path, steps: this.steps })

        const stepOutput = executionJournal.getOwnStep({ target: stateAtPath, stepName })
        if (isNil(stepOutput)) {
            return undefined
        }
        assertEqual(stepOutput.type, FlowActionType.LOOP_ON_ITEMS, 'stepOutput.type', 'LOOP_ON_ITEMS')
        return new LoopStepOutput(stepOutput as GenericStepOutput<FlowActionType.LOOP_ON_ITEMS, LoopStepResult>)
    }

    public isCompleted({ stepName }: { stepName: string }): boolean {
        const stateAtPath = executionJournal.getStateAtPath({ path: this.currentPath.path, steps: this.steps })
        const stepOutput = executionJournal.getOwnStep({ target: stateAtPath, stepName })
        if (isNil(stepOutput)) {
            return false
        }
        return stepOutput.status !== StepOutputStatus.PAUSED
    }

    public isPaused({ stepName }: { stepName: string }): boolean {
        const stateAtPath = executionJournal.getStateAtPath({ path: this.currentPath.path, steps: this.steps })
        const stepOutput = executionJournal.getOwnStep({ target: stateAtPath, stepName })
        if (isNil(stepOutput)) {
            return false
        }
        return stepOutput.status === StepOutputStatus.PAUSED
    }

    public setDuration(duration: number): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            duration,
        })
    }


    public addTags(tags: string[]): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            tags: [...this.tags, ...tags].filter((value, index, self) => {
                return self.indexOf(value) === index
            }),
        })
    }

    public async upsertStep(stepName: string, stepOutput: BaseStepOutput): Promise<FlowExecutorContext> {
        const stepLogPolicy = this.stepLogPolicy.get(stepName)
        const truncated = logRedaction.withRedactedInput(withTruncatedInput(stepOutput), stepLogPolicy)
        let finalized: BaseStepOutput
        if (truncated.type === FlowActionType.LOOP_ON_ITEMS) {
            finalized = truncated
        }
        else if (truncated.outputType === StepOutputType.SLICE) {
            // Already a slice ref — happens on RESUME when steps are restored from a log file.
            // The ref payload is tiny (sub-threshold) so re-slicing would no-op and silently
            // drop the discriminant, leaving downstream variable resolution with a raw
            // LogSliceRef instead of the materialized output.
            finalized = truncated
        }
        else {
            // A step whose output is not logged is never sliced: the slice file is written
            // separately and would outlive the redaction applied to the serialized step.
            const sliced = this.slicingEnabled && stepLogPolicy?.logOutput !== false
                ? await maybeSliceOutput(truncated.output, this.engineApi)
                : undefined
            finalized = new GenericStepOutput({
                type: truncated.type,
                status: truncated.status,
                input: truncated.input,
                output: sliced?.ref ?? truncated.output,
                outputType: sliced ? StepOutputType.SLICE : undefined,
                duration: truncated.duration,
                errorMessage: truncated.errorMessage,
            })
        }
        loggingUtils.recordUpsert({ steps: this.steps, stepName, stepOutput: finalized, previous: this.getStepOutput(stepName) })
        const steps = executionJournal.upsertStep({ stepName, stepOutput: finalized, path: this.currentPath.path, steps: this.steps })
        return new FlowExecutorContext({
            ...this,
            steps,
        })
    }

    // The journal is shared by every copy of this context and mutated in place, so this records
    // against the root every copy writes to.
    public recordInPlaceGrowth({ bytes }: { bytes: number }): void {
        loggingUtils.recordGrowth({ steps: this.steps, bytes })
    }

    // The copy handed to the log serializer. Redaction happens here, not in `upsertStep`, because
    // the in-memory output is the value later steps resolve against — replacing it in place would
    // break them. See `logRedaction.isOutputRedactionEnabled` for the PAUSED exception.
    public stepsForLog(): Readonly<Record<string, StepOutput>> {
        if (!logRedaction.hasPolicy({ stepLogPolicy: this.stepLogPolicy }) || !logRedaction.isOutputRedactionEnabled({ status: this.verdict.status })) {
            return this.steps
        }
        return logRedaction.redactStepsForLog({ steps: this.steps, stepLogPolicy: this.stepLogPolicy })
    }

    public getStepOutput(stepName: string, path?: StepExecutionPath['path']): StepOutput | undefined {
        return executionJournal.getStep({ stepName, path: path ?? this.currentPath.path, steps: this.steps })
    }

    public setLoopItems({ loopName, items }: { loopName: string, items: readonly unknown[] }): void {
        this.loopItems.set(loopItemsKey({ parentPath: this.currentPath.path, loopName }), items)
    }

    // The context one iteration runs in: its own path and verdict over the shared journal.
    public forkForIteration({ loopName, iteration, concurrent }: { loopName: string, iteration: number, concurrent: boolean }): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            currentPath: this.currentPath.loopIteration({ loopName, iteration }),
            verdict: { status: FlowRunStatus.RUNNING },
            isConcurrentFork: this.isConcurrentFork || concurrent,
            isIterationFork: true,
        })
    }

    public clearLoopItems({ loopName }: { loopName: string }): void {
        this.loopItems.delete(loopItemsKey({ parentPath: this.currentPath.path, loopName }))
    }

    public setCurrentPath(currentStatePath: StepExecutionPath): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            currentPath: currentStatePath,
        })
    }

    public setVerdict(verdict: FlowVerdict): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            verdict,
        })
    }

    public setRetryable(retryable: boolean): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            retryable,
        })
    }

    public addStepsExecuted(count: number): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            stepsCount: this.stepsCount + count,
        })
    }

    public incrementStepsExecuted(): FlowExecutorContext {
        return new FlowExecutorContext({
            ...this,
            stepsCount: this.stepsCount + 1,
        })
    }
    public async currentState(referencedStepNames?: string[]): Promise<Record<string, unknown>> {
        const referencedSteps = referencedStepNames
            ? referencedStepNames.reduce((acc, stepName) => {
                const step = executionJournal.getOwnStep({ target: this.steps, stepName })
                if (!isNil(step)) executionJournal.setOwnStep({ target: acc, stepName, value: step })
                return acc
            }, {} as Record<string, StepOutput>)
            : this.steps

        let flattened: Record<string, unknown> = await extractStepView({ steps: referencedSteps, engineApi: this.engineApi, cache: this.resolvedStepOutputCache, errorViewCache: this.errorViewCache })
        let targetMap = this.steps

        const path = this.currentPath.path
        for (let depth = 0; depth < path.length; depth++) {
            const [stepName, iteration] = path[depth]
            const stepOutput = executionJournal.getOwnStep({ target: targetMap, stepName })
            if (isNil(stepOutput) || !stepOutput.output || stepOutput.type !== FlowActionType.LOOP_ON_ITEMS) {
                throw new EngineGenericError('NotInstanceOfLoopOnItemsStepOutputError', '[ExecutionState#getTargetMap] Not instance of Loop On Items step output')
            }
            flattened = withIterationItem({
                view: flattened,
                loopName: stepName,
                iteration,
                items: this.loopItems.get(loopItemsKey({ parentPath: path.slice(0, depth), loopName: stepName })),
            })
            targetMap = stepOutput.output.iterations[iteration]
            flattened = {
                ...flattened,
                ...await extractStepView({ steps: targetMap, engineApi: this.engineApi, cache: this.resolvedStepOutputCache, errorViewCache: this.errorViewCache }),
            }
        }
        return flattened
    }
}

function loopItemsKey({ parentPath, loopName }: { parentPath: readonly [string, number][], loopName: string }): string {
    return JSON.stringify([parentPath, loopName])
}

function withIterationItem({ view, loopName, iteration, items }: WithIterationItemParams): Record<string, unknown> {
    const loopView = executionJournal.getOwnStep({ target: view, stepName: loopName })
    if (isNil(items) || !isRecord(loopView) || !isRecord(loopView.output)) {
        return view
    }
    const withItem: Record<string, unknown> = { ...view }
    executionJournal.setOwnStep({
        target: withItem,
        stepName: loopName,
        value: { ...loopView, output: { ...loopView.output, item: items[iteration], index: iteration + 1 } },
    })
    return withItem
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function extractStepView({ steps, engineApi, cache, errorViewCache }: ExtractStepViewParams): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}
    for (const [stepName, step] of Object.entries(steps)) {
        const output = await resolveStepOutput(step, engineApi, cache)
        const error = step.status === StepOutputStatus.FAILED && step.errorMessage !== undefined
            ? stepErrorView.build({ errorMessage: step.errorMessage, cache: errorViewCache })
            : undefined
        executionJournal.setOwnStep({ target: result, stepName, value: { output, error } })
    }
    return result
}

async function maybeSliceOutput(value: unknown, engineApi?: EngineApiConfig): Promise<{ ref: LogSliceRef } | undefined> {
    if (isNil(value) || isNil(engineApi)) {
        return undefined
    }
    const size = utils.sizeof(value)
    if (size <= SLICE_THRESHOLD_BYTES) {
        return undefined
    }
    const data = new TextEncoder().encode(JSON.stringify(value))
    const { fileId, readUrl } = await engineFileApi.upload({
        apiUrl: engineApi.internalApiUrl,
        engineToken: engineApi.engineToken,
        fileId: apId(),
        type: FileType.FLOW_RUN_LOG_SLICE,
        fileName: 'output.json',
        data,
    })
    return { ref: { fileId, size, url: readUrl } }
}

async function resolveStepOutput(step: StepOutput, engineApi: EngineApiConfig | undefined, cache: Map<string, Promise<unknown>>): Promise<unknown> {
    if (step.outputType !== StepOutputType.SLICE) {
        return step.output
    }
    if (isNil(engineApi)) {
        throw new EngineGenericError('MissingEngineApiConfigError', 'Cannot materialize log slice ref without engine api config')
    }
    const ref = step.output as LogSliceRef
    const existing = cache.get(ref.fileId)
    if (!isNil(existing)) {
        return existing
    }
    const promise = engineFileApi.download({ apiUrl: engineApi.internalApiUrl, engineToken: engineApi.engineToken, fileId: ref.fileId })
        .then((bytes) => JSON.parse(new TextDecoder('utf-8').decode(bytes)))
    cache.set(ref.fileId, promise)
    return promise
}

function withTruncatedInput<T extends BaseStepOutput>(stepOutput: T): T {
    const truncated = stepOutput.type === FlowActionType.LOOP_ON_ITEMS
        ? loggingUtils.maybeTruncateLoopInput(stepOutput.input)
        : loggingUtils.maybeTruncateInput(stepOutput.input)
    if (truncated === stepOutput.input) {
        return stepOutput
    }
    return Object.assign(
        Object.create(Object.getPrototypeOf(stepOutput)),
        stepOutput,
        { input: truncated },
    )
}

export type FlowVerdict = {
    status: FlowRunStatus.PAUSED
} | {
    status: FlowRunStatus.SUCCEEDED
    stopResponse: RespondResponse | undefined
} | {
    status: FlowRunStatus.FAILED | FlowRunStatus.LOG_SIZE_EXCEEDED
    failedStep: FailedStep
} | {
    status: FlowRunStatus.RUNNING
}

export type EngineApiConfig = {
    engineToken: string
    internalApiUrl: string
}

type WithIterationItemParams = {
    view: Record<string, unknown>
    loopName: string
    iteration: number
    items: readonly unknown[] | undefined
}

type ExtractStepViewParams = {
    steps: Record<string, StepOutput>
    engineApi: EngineApiConfig | undefined
    cache: Map<string, Promise<unknown>>
    errorViewCache: Map<string, StepErrorView>
}

export type FlowExecutorContextInit = {
    engineApi?: EngineApiConfig
    slicingEnabled?: boolean
    stepLogPolicy?: Map<string, StepLogPolicy>
}
