import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    Step,
} from '@aiqadam/shared'
import { Migration } from '.'

function renamePiecePackage(name: string): string {
    return name.replace(/^@aiqadam\/piece-/, '@aiqadam/qadam-')
}

function migrateStepSettings(step: Step): Step {
    if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
        return step
    }

    const settings = step.settings
    const qadamName = 'pieceName' in settings
        ? renamePiecePackage((settings as Record<string, unknown>).pieceName as string)
        : settings.qadamName
    const qadamVersion = 'pieceVersion' in settings
        ? (settings as Record<string, unknown>).pieceVersion as string
        : settings.qadamVersion

    return {
        ...step,
        settings: {
            ...settings,
            qadamName,
            qadamVersion,
        },
    }
}

export const migrateV22RenamePieceToQadam: Migration = {
    targetSchemaVersion: '22',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, migrateStepSettings)
        return {
            ...newFlowVersion,
            schemaVersion: '23',
        }
    },
}
