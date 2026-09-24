import { BaseStepOutput, FlowAction, FlowActionType, FlowRunStatus, flowStructureUtil, FlowTrigger, isNil, LoopStepOutput, Step, StepOutput } from '@aiqadam/shared'

export const REDACTED_VALUE = '**REDACTED**'

export const logRedaction = {
    // A `Map`, not a `Record`: `step.name` comes straight from flow content, and
    // `STEP_NAME_REGEX` admits `__proto__` — which survives `ap_import_flow` verbatim. A bare
    // bracket assignment (`policy[step.name] = ...`) for that key does not create an own property
    // at all; it invokes the inherited `Object.prototype.__proto__` setter and silently changes
    // the returned object's own prototype instead. `Object.keys()` (`hasPolicy`, below) then can't
    // see the entry, so a step legitimately named `__proto__` that opts out of logging its output
    // has that opt-out silently defeated wherever nothing else in the flow also has a policy entry
    // — its sensitive output/input still lands in the persisted run log.
    buildStepLogPolicy({ trigger }: BuildStepLogPolicyParams): Map<string, StepLogPolicy> {
        const policy = new Map<string, StepLogPolicy>()
        for (const step of flowStructureUtil.getAllSteps(trigger)) {
            // The trigger only opts out of its output (#505): its logged input is configuration,
            // the payload that carries user data is the output.
            if (!isActionStep(step)) {
                if (!isNil(step.logOutput)) {
                    policy.set(step.name, { logInput: true, logOutput: step.logOutput })
                }
                continue
            }
            if (isNil(step.logInput) && isNil(step.logOutput)) {
                continue
            }
            policy.set(step.name, {
                logInput: step.logInput ?? true,
                logOutput: step.logOutput ?? true,
            })
        }
        return withCollectedRedaction({ trigger, policy })
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
    hasPolicy({ stepLogPolicy }: { stepLogPolicy: Map<string, StepLogPolicy> }): boolean {
        return stepLogPolicy.size > 0
    },
}

function isActionStep(step: Step): step is FlowAction {
    return flowStructureUtil.isAction(step.type)
}

function redactStepForLog({ stepName, step, stepLogPolicy }: RedactStepParams): StepOutput {
    const policy = stepLogPolicy.get(stepName)
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
            const redacted = loop.setIterations(iterations.map((iteration) =>
                logRedaction.redactStepsForLog({ steps: iteration, stepLogPolicy }),
            ))
            const collected = redacted.output?.collected
            if (policy?.redactCollected !== true || isNil(collected) || isNil(redacted.output)) {
                return redacted
            }
            return new LoopStepOutput({
                ...redacted,
                output: { ...redacted.output, collected: collected.map((value) => isNil(value) ? value : REDACTED_VALUE) },
            })
        }
    }
    return step
}

// A loop's `collected` holds whatever its `collect.value` read, so a value read from a step that
// opted out of logging its output must not reach the log through the loop instead (#41). Matched
// by substring, as the props resolver finds referenced steps: over-matching only redacts more.
function withCollectedRedaction({ trigger, policy }: { trigger: FlowTrigger, policy: Map<string, StepLogPolicy> }): Map<string, StepLogPolicy> {
    const unloggedOutputs = [...policy.entries()].filter(([, entry]) => !entry.logOutput).map(([name]) => name)
    if (unloggedOutputs.length === 0) {
        return policy
    }
    const withCollected = new Map(policy)
    for (const step of flowStructureUtil.getAllSteps(trigger)) {
        if (step.type !== FlowActionType.LOOP_ON_ITEMS || isNil(step.settings.collect)) {
            continue
        }
        const collectValue = step.settings.collect.value
        if (!unloggedOutputs.some((name) => collectValue.includes(name))) {
            continue
        }
        const existing = policy.get(step.name)
        withCollected.set(step.name, {
            logInput: existing?.logInput ?? true,
            logOutput: existing?.logOutput ?? true,
            redactCollected: true,
        })
    }
    return withCollected
}

export type StepLogPolicy = {
    logInput: boolean
    logOutput: boolean
    redactCollected?: boolean
}

type BuildStepLogPolicyParams = {
    trigger: FlowTrigger
}

type RedactStepParams = {
    stepName: string
    step: StepOutput
    stepLogPolicy: Map<string, StepLogPolicy>
}

type RedactStepsParams = {
    steps: Record<string, StepOutput>
    stepLogPolicy: Map<string, StepLogPolicy>
}
