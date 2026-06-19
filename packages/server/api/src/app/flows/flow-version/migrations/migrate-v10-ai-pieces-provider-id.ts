import {
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
} from '@aiqadam/shared'
import { Migration } from '.'


export const migrateV10AiPiecesProviderId: Migration = {
    targetSchemaVersion: '10',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if (step.type !== FlowActionType.PIECE) {
                return step
            }
            if (step.settings.qadamName !== '@aiqadam/qadam-ai' || !['0.0.1', '0.0.2'].includes(step.settings.qadamVersion)) {
                return step
            }

            const input = step.settings?.input as Record<string, unknown>

            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamName: '@aiqadam/qadam-ai',
                    qadamVersion: '0.0.4',
                    input,
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '11',
        }
    },
}


