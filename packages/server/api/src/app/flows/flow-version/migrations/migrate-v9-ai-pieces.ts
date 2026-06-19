import {
    FlowAction,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
    QadamAction,
} from '@aiqadam/shared'
import { Migration } from '.'


export const migrateV9AiPieces: Migration = {
    targetSchemaVersion: '9',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE) {
                return step
            }
            if (step.settings.qadamName === '@aiqadam/qadam-text-ai') {
                return migrateTextai(step)
            }
            if (step.settings.qadamName === '@aiqadam/qadam-utility-ai') {
                return migrateUtilityAction(step)
            }
            if (step.settings.qadamName === '@aiqadam/qadam-image-ai') {
                return migrateImageai(step)
            }
            return step
        })

        return {
            ...newVersion,
            schemaVersion: '10',
        }
    },
}

function migrateUtilityAction(step: QadamAction): FlowAction {
    const input = step.settings?.input as Record<string, unknown>
    return {
        ...step,
        settings: {
            ...step.settings,
            qadamName: '@aiqadam/qadam-ai',
            qadamVersion: '0.0.2',
            input: {
                ...input,
                ...migrateModel(input.provider as string, extractModelFromInput(input)),
                // Fix typo in older version
                schema: input?.schama as Record<string, unknown>,
                maxOutputTokens: input.maxTokens ?? input?.maxOutputTokens,
                maxTokens: undefined,
            },
        },
    }
}
function migrateTextai(step: QadamAction): FlowAction {
    const actionName = step.settings.actionName
    const input = step.settings?.input as Record<string, unknown>

    if (actionName === 'askAi') {
        const webSearchOptions = (input['webSearchOptions'] ?? {}) as Record<string, unknown>
        const includeSources = webSearchOptions.includeSources ?? input?.includeSources

        // Max Tokens is replaced by maxOutputTokens
        // Include Sources is replaced by webSearchOptions.includeSources
        return {
            ...step,
            settings: {
                ...step.settings,
                qadamName: '@aiqadam/qadam-ai',
                actionName: 'askAi',
                qadamVersion: '0.0.2',
                input: {
                    ...input,
                    webSearchOptions: {
                        ...webSearchOptions,
                        includeSources,
                    },
                    ...migrateModel(input.provider as string, extractModelFromInput(input)),
                    maxTokens: undefined,
                    includeSources: undefined,
                },
            },
        }
    }

    return {
        ...step,
        settings: {
            ...step.settings,
            qadamName: '@aiqadam/qadam-ai',
            qadamVersion: '0.0.2',
            input: {
                ...step.settings.input,
                ...migrateModel(input.provider as string, extractModelFromInput(input)),
                maxOutputTokens: input.maxTokens ?? input?.maxOutputTokens,
                maxTokens: undefined,
            },
        },
    }
}

function migrateImageai(step: QadamAction): FlowAction {
    const input = step.settings?.input as Record<string, unknown>
    const files = 'image' in input && !isNil(input.image) ? [{ file: input.image }] : input.files
    return {
        ...step,
        settings: {
            ...step.settings,
            qadamName: '@aiqadam/qadam-ai',
            qadamVersion: '0.0.2',
            input: {
                ...input,
                images: files,
                ...migrateModel(input.provider as string, extractModelFromInput(input)),
                resolution: undefined,
                advancedOptions: {
                    ...(input?.advancedOptions ?? {}),
                    size: input?.resolution ?? input?.size,
                },
            },
        },
    }
}

function extractModelFromInput(input: Record<string, unknown>): string {
    const model = input?.model as unknown
    if (typeof model === 'string') {
        return model
    }
    return (model as { modelId: string })?.modelId
}

function migrateModel(provider: string | undefined, modelId: string): { model: string | undefined, provider: string | undefined } {
    return {
        provider,
        model: modelId,
    }
}

