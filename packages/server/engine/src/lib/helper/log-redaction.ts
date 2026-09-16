import { BaseStepOutput, FlowAction, FlowActionType, FlowRunStatus, flowStructureUtil, FlowTrigger, isNil, LoopStepOutput, Step, StepOutput } from '@aiqadam/shared'

export const REDACTED_VALUE = '**REDACTED**'

export const logRedaction = {
    buildStepLogPolicy({ trigger }: BuildStepLogPolicyParams): Record<string, StepLogPolicy> {
        const policy: Record<string, StepLogPolicy> = {}
        for (const step of flowStructureUtil.getAllSteps(trigger)) {
            if (!isActionStep(step)) {
                continue
            }
            if (isNil(step.logInput) && isNil(step.logOutput)) {
                continue
            }
            policy[step.name] = {
                logInput: step.logInput ?? true,
                logOutput: step.logOutput ?? true,
            }
        }
        return policy
    },
    // Applied when the step is written into the execution state. A step's own output is never
    // redacted here: `stepsForLog()` does that on the copy handed to the serializer, because the
    // live output must stay readable by the steps that follow.
    withRedactedInput<T extends BaseStepOutput>(stepOutput: T, policy: StepLogPolicy | undefined): T {
        if (policy?.logInput !== false || stepOutput.input === REDACTED_VALUE) {
            return stepOutput
        }
        return Object.assign(
            Object.create(Object.getPrototypeOf(stepOutput)),
            stepOutput,
            { input: REDACTED_VALUE },
        )
    },
    redactStepsForLog({ steps, stepLogPolicy }: RedactStepsParams): Record<string, StepOutput> {
        return Object.fromEntries(
            Object.entries(steps).map(([stepName, step]) => [stepName, redactStepForLog({ stepName, step, stepLogPolicy })]),
        )
    },
    // A paused run keeps its outputs: the log file is the only thing RESUME can hydrate from
    // (`fetchExecutionStateFromLogs`), so redacting an output here would feed `**REDACTED**` into
    // the steps that run after the resume. The terminal backup redacts it instead.
    isOutputRedactionEnabled({ status }: { status: FlowRunStatus }): boolean {
        return status !== FlowRunStatus.PAUSED
    },
    hasPolicy({ stepLogPolicy }: { stepLogPolicy: Record<string, StepLogPolicy> }): boolean {
        return Object.keys(stepLogPolicy).length > 0
    },
}

function isActionStep(step: Step): step is FlowAction {
    return flowStructureUtil.isAction(step.type)
}

function redactStepForLog({ stepName, step, stepLogPolicy }: RedactStepParams): StepOutput {
    const policy = stepLogPolicy[stepName]
    if (policy?.logOutput === false) {
        return Object.assign(
            Object.create(Object.getPrototypeOf(step)),
            step,
            { output: REDACTED_VALUE },
        )
    }
    if (step.type === FlowActionType.LOOP_ON_ITEMS) {
        const loop = new LoopStepOutput(step)
        const iterations = loop.output?.iterations
        if (!isNil(iterations)) {
            return loop.setIterations(iterations.map((iteration) =>
                logRedaction.redactStepsForLog({ steps: iteration, stepLogPolicy }),
            ))
        }
    }
    return step
}

export type StepLogPolicy = {
    logInput: boolean
    logOutput: boolean
}

type BuildStepLogPolicyParams = {
    trigger: FlowTrigger
}

type RedactStepParams = {
    stepName: string
    step: StepOutput
    stepLogPolicy: Record<string, StepLogPolicy>
}

type RedactStepsParams = {
    steps: Record<string, StepOutput>
    stepLogPolicy: Record<string, StepLogPolicy>
}
