import { LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    GenericStepOutput,
    isNil,
    LoopStepOutput,
    RouterStepOutput,
    spreadIfDefined,
    Step,
    StepOutputStatus,
    tryCatch,
} from '@aiqadam/shared'
import { createPropsResolver } from '../../variables/props-resolver'
import { EngineConstants } from './engine-constants'
import { FlowExecutorContext } from './flow-execution-context'

export const testExecutionContext = {
    async stateFromFlowVersion({
        flowVersion,
        excludedStepName,
        projectId,
        engineToken,
        apiUrl,
        sampleData,
        engineConstants,
    }: TestExecutionParams): Promise<FlowExecutorContext> {
        let flowExecutionContext = FlowExecutorContext.empty({
            engineApi: { engineToken, internalApiUrl: apiUrl },
            slicingEnabled: false,
            stepLogPolicy: engineConstants.stepLogPolicy,
        })
        if (isNil(flowVersion)) {
            return flowExecutionContext
        }
        
        const flowSteps = flowStructureUtil.getAllSteps(flowVersion.trigger)

        for (const step of flowSteps) {
            const { name } = step
            if (name === excludedStepName) {
                continue
            }

            const stepType = step.type
            switch (stepType) {
                case FlowActionType.ROUTER:
                    flowExecutionContext = await flowExecutionContext.upsertStep(
                        step.name,
                        RouterStepOutput.create({
                            input: step.settings,
                            type: stepType,
                            status: StepOutputStatus.SUCCEEDED,
                            ...spreadIfDefined('output', sampleData?.[step.name]),
                        }),
                    )
                    break
                case FlowActionType.LOOP_ON_ITEMS: {
                    const { resolvedInput } = await createPropsResolver({
                        apiUrl,
                        projectId,
                        engineToken,
                        contextVersion: LATEST_CONTEXT_VERSION,
                        stepNames: engineConstants.stepNames,
                        constants: engineConstants,
                    }).resolve<{ items: unknown[] }>({
                        unresolvedInput: { items: step.settings.items },
                        executionState: flowExecutionContext,
                    })
                    flowExecutionContext = await flowExecutionContext.upsertStep(
                        step.name,
                        LoopStepOutput.init({
                            input: step.settings,
                        }).setOutput({
                            item: resolvedInput.items[0],
                            index: 1,
                            iterations: [],
                        }),
                    )
                    break
                }
                case FlowActionType.PIECE:
                case FlowActionType.CODE:
                case FlowTriggerType.EMPTY:
                case FlowTriggerType.PIECE:
                    flowExecutionContext = await flowExecutionContext.upsertStep(step.name, GenericStepOutput.create({
                        input: {},
                        type: stepType,
                        status: StepOutputStatus.SUCCEEDED,
                        ...spreadIfDefined('output', sampleData?.[step.name]),
                    }))
                    break
            }
        }
        return withCollectedSamples({ flowExecutionContext, flowSteps, apiUrl, projectId, engineToken, engineConstants })
    },
}

// #41: a later step tested on its own reads `{{loop.output.collected}}`. A loop's sample has no
// iterations to collect from, so `collected` holds the value for the first item, resolved against
// the sample data of the loop's body steps — which exist only once every step above is written.
async function withCollectedSamples({ flowExecutionContext, flowSteps, apiUrl, projectId, engineToken, engineConstants }: WithCollectedSamplesParams): Promise<FlowExecutorContext> {
    let context = flowExecutionContext
    for (const step of flowSteps) {
        if (step.type !== FlowActionType.LOOP_ON_ITEMS || isNil(step.settings.collect)) {
            continue
        }
        const loopOutput = context.getLoopStepOutput({ stepName: step.name })
        if (isNil(loopOutput)) {
            continue
        }
        const { data: resolved } = await tryCatch(() => createPropsResolver({
            apiUrl,
            projectId,
            engineToken,
            contextVersion: LATEST_CONTEXT_VERSION,
            stepNames: engineConstants.stepNames,
            constants: engineConstants,
        }).resolve<{ value: unknown }>({
            unresolvedInput: { value: step.settings.collect?.value },
            executionState: context,
        }))
        context = await context.upsertStep(step.name, new LoopStepOutput({
            ...loopOutput,
            output: {
                item: loopOutput.output?.item,
                index: loopOutput.output?.index ?? 1,
                iterations: loopOutput.output?.iterations ?? [],
                collected: [resolved?.resolvedInput.value ?? null],
                failures: [],
            },
        }))
    }
    return context
}


type WithCollectedSamplesParams = {
    flowExecutionContext: FlowExecutorContext
    flowSteps: Step[]
    apiUrl: string
    projectId: string
    engineToken: string
    engineConstants: EngineConstants
}

type TestExecutionParams = {
    engineConstants: EngineConstants
    flowVersion?: FlowVersion
    excludedStepName?: string
    projectId: string
    apiUrl: string
    engineToken: string
    sampleData?: Record<string, unknown>
}