import { isNil } from '../../../core/common'
import { FlowActionType } from '../../flows/actions/action'
import { FlowTriggerType } from '../../flows/triggers/trigger'

export enum StepOutputStatus {
    FAILED = 'FAILED',
    PAUSED = 'PAUSED',
    RUNNING = 'RUNNING',
    STOPPED = 'STOPPED',
    SUCCEEDED = 'SUCCEEDED',
}

type BaseStepOutputParams<T extends FlowActionType | FlowTriggerType, OUTPUT> = {
    type: T
    status: StepOutputStatus
    input: unknown
    output?: OUTPUT
    outputType?: StepOutputType
    duration?: number
    errorMessage?: string
}

export class GenericStepOutput<T extends FlowActionType | FlowTriggerType, OUTPUT> {
    type: T
    status: StepOutputStatus
    input: unknown
    output?: OUTPUT
    outputType?: StepOutputType
    duration?: number
    errorMessage?: string

    constructor(step: BaseStepOutputParams<T, OUTPUT>) {
        this.type = step.type
        this.status = step.status
        this.input = step.input
        this.output = step.output
        this.outputType = step.outputType
        this.duration = step.duration
        this.errorMessage = step.errorMessage
    }

    setOutput(output: OUTPUT): GenericStepOutput<T, OUTPUT> {
        return new GenericStepOutput<T, OUTPUT>({
            ...this,
            output,
        })
    }

    setStatus(status: StepOutputStatus): GenericStepOutput<T, OUTPUT> {
        return new GenericStepOutput<T, OUTPUT>({
            ...this,
            status,
        })
    }

    setErrorMessage(errorMessage: string): GenericStepOutput<T, OUTPUT> {
        return new GenericStepOutput<T, OUTPUT>({
            ...this,
            errorMessage,
        })
    }

    setDuration(duration: number): GenericStepOutput<T, OUTPUT> {
        return new GenericStepOutput<T, OUTPUT>({
            ...this,
            duration,
        })
    }

    static create<T extends FlowActionType | FlowTriggerType, OUTPUT>({
        input,
        type,
        status,
        output,
    }: {
        input: unknown
        type: T
        status: StepOutputStatus
        output?: OUTPUT
    }): GenericStepOutput<T, OUTPUT> {
        return new GenericStepOutput<T, OUTPUT>({
            input,
            type,
            status,
            output,
        })
    }
}

export enum StepOutputType {
    SLICE = 'slice',
}

/**
 * Payload stored in `StepOutput.output` when the host step has `outputType: StepOutputType.SLICE`.
 * Distinguished structurally by the step's `outputType` field, so the ref itself
 * carries no marker.
 */
export type LogSliceRef = {
    fileId: string
    size: number
    url: string
}

export const FLOW_RUN_LOG_MANIFEST_V2 = 2

export type BaseStepOutput = GenericStepOutput<FlowActionType | FlowTriggerType, unknown>

export type StepOutput =
  | GenericStepOutput<FlowActionType.LOOP_ON_ITEMS, LoopStepResult>
  | GenericStepOutput<FlowActionType.ROUTER, unknown>
  | GenericStepOutput<
  | Exclude<FlowActionType, FlowActionType.LOOP_ON_ITEMS | FlowActionType.ROUTER>
  | FlowTriggerType,
  unknown
  >

type BranchResult = {
    branchName: string
    branchIndex: number
    evaluation: boolean
}

type RouterStepResult = {
    branches: BranchResult[]
}

export class RouterStepOutput extends GenericStepOutput<
FlowActionType.ROUTER,
RouterStepResult
> {
    static init({ input }: { input: unknown }): RouterStepOutput {
        return new RouterStepOutput({
            type: FlowActionType.ROUTER,
            input,
            status: StepOutputStatus.SUCCEEDED,
        })
    }
}

export type LoopStepResult = {
    item: unknown
    index: number
    iterations: Record<string, StepOutput>[]
    // #41. Positional: `collected[i]` belongs to item `i`, `null` where the iteration failed or was
    // skipped, so retries and concurrency cannot reorder it.
    collected?: unknown[]
    // Compact: one entry per failed iteration, so its length is the number of failures.
    failures?: LoopIterationFailure[]
    // One entry per finished iteration. A RESUME skips an `S` iteration without entering its body,
    // which is what makes a blanked body (`keepBodies`) safe to replay.
    iterationStatus?: LoopIterationStatus[]
    // Set once a durable loop has paused itself (#387): why and how often, and the item list it
    // must find again when it resumes.
    checkpoint?: LoopCheckpoint
}

export class LoopStepOutput extends GenericStepOutput<
FlowActionType.LOOP_ON_ITEMS,
LoopStepResult
> {
    constructor(
        step: BaseStepOutputParams<FlowActionType.LOOP_ON_ITEMS, LoopStepResult>,
    ) {
        super(step)
        this.output = step.output ?? {
            item: undefined,
            index: 0,
            iterations: [],
        }
    }

    static init({ input }: { input: unknown }): LoopStepOutput {
        return new LoopStepOutput({
            type: FlowActionType.LOOP_ON_ITEMS,
            input,
            status: StepOutputStatus.SUCCEEDED,
        })
    }

    setIterations(iterations: Record<string, StepOutput>[]): LoopStepOutput {
        return new LoopStepOutput({
            ...this,
            output: {
                ...this.output,
                iterations,
            },
        })
    }

    hasIteration(iteration: number): boolean {
        return !isNil(this.output?.iterations[iteration])
    }

    setItemAndIndex({
        item,
        index,
    }: {
        item: unknown
        index: number
    }): LoopStepOutput {
        return new LoopStepOutput({
            ...this,
            output: {
                ...this.output,
                item,
                index,
                iterations: this.output?.iterations ?? [],
            },
        })
    }

    addIteration(): LoopStepOutput {
        return new LoopStepOutput({
            ...this,
            output: {
                ...this.output,
                item: this.output?.item,
                index: this.output?.index,
                iterations: [...(this.output?.iterations ?? []), {}],
            },
        })
    }
}

export type LoopIterationFailure = {
    index: number
    stepName: string
    description: string
}

// One character each: a loop of tens of thousands of items carries one of these per item in its
// persisted log.
export enum LoopIterationStatus {
    SUCCEEDED = 'S',
    FAILED = 'F',
}

export type LoopCheckpoint = {
    count: number
    lastAt: string
    reason: LoopCheckpointReason
    itemsCount: number
    itemsHash: string
}

export enum LoopCheckpointReason {
    BUDGET = 'BUDGET',
    LOG_SIZE = 'LOG_SIZE',
    RATE_LIMIT = 'RATE_LIMIT',
}
