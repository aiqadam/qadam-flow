import { isNil } from '../../../core/common'
import { FlowActionType } from '../../flows/actions/action'
import { BaseStepOutput, LoopStepOutput, StepOutput, StepOutputStatus } from './step-output'

export const executionJournal = {

    // `stepName` comes straight from flow content (`STEP_NAME_REGEX` admits `constructor`,
    // `toString`, `valueOf`, `hasOwnProperty` and `__proto__`, and they survive `ap_import_flow`
    // verbatim), and `steps`/`target` here must stay a plain, JSON-serializable `Record` — it is
    // `FlowRun.steps`, persisted as-is. `Object.hasOwn`, not a bare index: a bare read for a step
    // that has never run resolves those names off `Object.prototype` (a function, or — for
    // `__proto__` — the object's own current prototype) instead of `undefined`, and every caller's
    // `if (!step)` / `isNil(...)` guard treats that as "found". Exported (not a private helper) so
    // every place that reads a step out of a `Record<string, StepOutput>` — inside this file, in
    // the engine's `FlowExecutorContext`, and in `flow.operation.ts`'s RESUME rebuild — shares the
    // one implementation instead of growing a fourth copy.
    getOwnStep<T>(target: Record<string, T>, stepName: string): T | undefined {
        return Object.hasOwn(target, stepName) ? target[stepName] : undefined
    },

    // `Object.defineProperty`, not a bracket assignment: assigning to the literal key `__proto__`
    // does not create an own property at all — it invokes the inherited
    // `Object.prototype.__proto__` setter and silently reassigns the target's own prototype
    // instead. The step's own output then becomes invisible to
    // `Object.keys`/`Object.entries`/`JSON.stringify` (i.e. the persisted run log) even though a
    // direct read of that literal key still resolves it, which is how the step's result can
    // silently vanish from the log while still being live in memory.
    setOwnStep<T>(target: Record<string, T>, stepName: string, value: T): void {
        Object.defineProperty(target, stepName, { value, writable: true, enumerable: true, configurable: true })
    },

    upsertStep({ stepName, stepOutput, path, steps, createLoopIterationIfNotExists }: UpsertStepParams): Record<string, StepOutput> {
        const target: Record<string, BaseStepOutput> = createLoopIterationIfNotExists ? this.getOrCreateStateAtPath({ path, steps }) : this.getStateAtPath({ path, steps })
        this.setOwnStep(target, stepName, stepOutput)
        return steps
    },

    getStep({ stepName, path, steps }: GetStepParams): StepOutput | undefined {
        return this.getOwnStep(this.getStateAtPath({ path, steps }), stepName)
    },

    getStateAtPath({ path, steps }: GetStateAtPathParams): Record<string, StepOutput> {
        let target = steps

        for (const [parentStepName, iteration] of path) {
            const step = this.getOwnStep(target, parentStepName)
            if (!step) {
                throw new Error(`Step ${parentStepName} not found in path ${path}`)
            }
            if (step.type !== FlowActionType.LOOP_ON_ITEMS) {
                throw new Error(`Step ${parentStepName} is not a loop on items step in path ${path}`)
            }
            const loopStepOutput = step as LoopStepOutput
            const iterationOutput = loopStepOutput.output?.iterations[iteration]
            if (!iterationOutput) {
                throw new Error(`Iteration ${iteration} not found in path ${path}`)
            }
            target = iterationOutput
        }
        return target
    },

    /*
     * if the steps object does not include loop step mentioned in the path, it gets created.
     * same for the iteration in the path. If the iteration is not found, it gets created.
     */
    getOrCreateStateAtPath({ path, steps }: GetStateAtPathParams): Record<string, StepOutput> {
        let target = steps

        for (const [parentStepName, iteration] of path) {
            let step = this.getOwnStep(target, parentStepName)
            if (!step ) {
                step = LoopStepOutput.init({ input: null })
            }
            if (step.type !== FlowActionType.LOOP_ON_ITEMS) {
                throw new Error(`Step ${parentStepName} is not a loop on items step in path ${path}`)
            }
            let loopStepOutput = step as LoopStepOutput
            let iterationOutput = loopStepOutput.output?.iterations[iteration]
            if (!iterationOutput ) {
                loopStepOutput = loopStepOutput.setItemAndIndex({ item: undefined, index: iteration }).addIteration()
                iterationOutput = loopStepOutput.output?.iterations[iteration] ?? {}
            }
            this.setOwnStep(target, parentStepName, loopStepOutput)
            target = iterationOutput
        }
        return target
    },

    findLastStepWithStatus(steps: Record<string, StepOutput>, status: StepOutputStatus | undefined): string | null {
        let lastStepWithStatus: string | null = null
        Object.entries(steps).forEach(([stepName, step]) => {
            if ( step.type === FlowActionType.LOOP_ON_ITEMS && step.output ) {
                const iterations = step.output.iterations
                iterations.forEach((iteration) => {
                    const lastOneInIteration = this.findLastStepWithStatus(iteration, status)
                    if (!isNil(lastOneInIteration)) {
                        lastStepWithStatus = lastOneInIteration
                    }
                })
            }
            if (isNil(status)) {
                lastStepWithStatus = stepName
                return
            }
            if (step.status === status) {
                lastStepWithStatus = stepName
                return
            }
        })
        return lastStepWithStatus
    },

    getLoopSteps(steps: Record<string, StepOutput>): Record<string, LoopStepOutput> {
        let result: Record<string, LoopStepOutput> = {}
        Object.entries(steps).forEach(([stepName, step]) => {
            if (step.type === FlowActionType.LOOP_ON_ITEMS) {
                const iterationsResult = step.output?.iterations.reduce((acc, iteration) => {
                    return {
                        ...acc,
                        ...this.getLoopSteps(iteration),
                    }
                }, {} as Record<string, LoopStepOutput>)
                if (isNil(iterationsResult)) {
                    this.setOwnStep(result, stepName, step as LoopStepOutput)
                    return
                }
                result = {
                    ...result,
                    ...iterationsResult as Record<string, LoopStepOutput>,
                    [stepName]: step as LoopStepOutput,
                }
            }
        })
        return result
    },

    isChildOf(parent: StepOutput, child: string): boolean {
        if (parent.type !== FlowActionType.LOOP_ON_ITEMS) return false
        if (!parent.output?.iterations) return false
        for (const iteration of parent.output.iterations) {
            for (const [name, output] of Object.entries(iteration)) {
                if (name === child) return true
                if (this.isChildOf(output, child)) return true
            }
        }
        return false
    },

    getPathToStep(
        steps: Record<string, StepOutput>,
        stepName: string,
        loopsIndexes: Record<string, number>,
        currentPath: readonly [string, number][] = [],
    ): readonly [string, number][] | undefined {


        for (const [currentStepName, step] of Object.entries(steps)) {
            if (currentStepName === stepName) {
                return currentPath
            }

            if (step.type !== FlowActionType.LOOP_ON_ITEMS) continue
            if (!step.output?.iterations) continue

            for (const iteration of step.output.iterations) {
                const nestedPath = this.getPathToStep(iteration, stepName, loopsIndexes, [...currentPath, [currentStepName, loopsIndexes[currentStepName]]])
                if (nestedPath) return nestedPath
            }
        }
        return undefined
    },
}

export type UpsertStepParams = {
    stepName: string
    stepOutput: BaseStepOutput
    path: readonly [string, number][]
    steps: Record<string, StepOutput>
    createLoopIterationIfNotExists?: boolean
}

export type GetStepParams = {
    stepName: string
    path: readonly [string, number][]
    steps: Record<string, StepOutput>
}

export type GetStateAtPathParams = {
    path: readonly [string, number][]
    steps: Record<string, StepOutput>
}
