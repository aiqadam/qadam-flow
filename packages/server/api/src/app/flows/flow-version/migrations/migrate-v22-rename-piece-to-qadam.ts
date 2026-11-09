import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    Step,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { Migration } from '.'

function renamePiecePackage(name: string): string {
    return name.replace(/^@aiqadam\/piece-/, '@aiqadam/qadam-')
}

// `settings` is whatever an untrusted flow version carries — `pieceName`, if present at all, is not
// guaranteed to be a string. A non-string value (object, number, null written by something other
// than the builder) would throw inside `renamePiecePackage`'s `.replace`, which `flowMigrationService`
// rethrows and pages on-call for, 500ing every read of that one flow version. Treat it the same as
// "nothing to migrate for this step" instead: leave the step untouched and log it (#1028).
function migrateStepSettings({ step, flowVersionId }: { step: Step, flowVersionId: string }): Step {
    if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
        return step
    }

    const settings = step.settings
    if ('pieceName' in settings && typeof (settings as Record<string, unknown>).pieceName !== 'string') {
        system.globalLogger().warn({ flowVersionId, stepName: step.name }, '[migrateV22RenamePieceToQadam] skipping step with a non-string pieceName')
        return step
    }

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
        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => migrateStepSettings({ step, flowVersionId: flowVersion.id }))
        return {
            ...newFlowVersion,
            schemaVersion: '23',
        }
    },
}
