import {
    Field,
    FlowActionType,
    flowStructureUtil,
    FlowVersion,
    isNil,
    Step,
} from '@aiqadam/shared'
import { In } from 'typeorm'
import { repoFactory } from '../../../core/db/repo-factory'
import { system } from '../../../helper/system/system'
import { FieldEntity } from '../../../tables/field/field.entity'
import { flowMigrationUtil } from './flow-migration-util'
import { Migration } from '.'

const fieldRepo = repoFactory<Field>(FieldEntity)

const TABLES_PIECE_NAME = '@aiqadam/qadam-tables'
const TARGET_ACTIONS = ['tables-create-records', 'tables-update-record']

function collectFieldIdsFromFlow(flowVersion: FlowVersion) {
    const fieldIds: string[] = []

    flowStructureUtil.getAllSteps(flowVersion.trigger).forEach((step) => {
        if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== TABLES_PIECE_NAME || !step.settings.qadamVersion.includes('0.1.')) {
            return
        }
        const actionName = step.settings.actionName as string | undefined
        if (!actionName || !TARGET_ACTIONS.includes(actionName)) {
            return
        }

        const input = step.settings?.input as Record<string, unknown>
        const values = input?.values as Record<string, unknown> | undefined
        const fieldsValues = actionName === 'tables-create-records' ? values?.values as Record<string, unknown>[] | undefined : values
        if (!fieldsValues) {
            return
        }
        if (Array.isArray(fieldsValues)) {
            for (const fieldValue of fieldsValues) {
                for (const [fieldId, _value] of Object.entries(fieldValue)) {
                    fieldIds.push(fieldId)
                }
            }
        }
        else {
            for (const fieldId of Object.keys(fieldsValues)) {
                fieldIds.push(fieldId)
            }
        }
    })

    return fieldIds
}

export const migrateV11TablesToV2: Migration = {
    targetSchemaVersion: '11',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const fieldIds = collectFieldIdsFromFlow(flowVersion)
        // Same data-isolation fix as `migrate-v18`, and the same reason it is needed: these ids are
        // the KEYS of `step.settings.input.values`, i.e. flow JSON that nothing validates against a
        // real field, so an id from another project reaches this query untouched on the
        // `ap_import_flow` path. `.agents/rules/data-isolation.md` requires the filter; without it
        // the migration resolves across the project boundary and writes the other project's
        // `externalId` into this flow version (#488).
        //
        // An undeterminable project resolves nothing rather than throwing, and on the IMPORT_FLOW
        // path that degrade — not the filter — is the whole defence, because
        // `migrateFlowVersionTemplate` hardcodes `flowId: ''`. See the longer note in
        // `migrate-v18` for both points and for what the degrade costs.
        //
        // Resolved only when there is something to resolve. Unlike `migrate-v18`, this migration
        // has no early return — it still has to run `transferFlow` below to pin `qadamVersion` on
        // any tables step — so the guard sits here instead. It matters because this runs over the
        // entire installed base at once, right after an image upgrade, and the overwhelming
        // majority of flow versions at schema 11 carry no tables step at all: without it, every
        // one of them would pay a `getOneById` round trip to learn there is nothing to look up.
        const projectId = fieldIds.length === 0
            ? undefined
            : await flowMigrationUtil.resolveProjectId({ flowId: flowVersion.flowId, flowVersionId: flowVersion.id, log: system.globalLogger() })
        const fields = isNil(projectId)
            ? []
            : await fieldRepo().find({
                where: { id: In([...fieldIds]), projectId },
            })

        const fieldIdToExternalId: Record<string, string> = {}
        for (const field of fields) {
            fieldIdToExternalId[field.id] = field.externalId
        }

        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step: Step) => {
            if (!isTablesStep(step)) {
                return step
            }
            const actionName = step.settings.actionName as string | undefined
            const justUpgradePiece = !isOldTablesStep(step) || isNil(actionName) || !TARGET_ACTIONS.includes(actionName as string)
            const input = step.settings?.input as Record<string, unknown>
            const values = input?.values as Record<string, unknown> | undefined
            const fieldsValue = actionName === 'tables-create-records' ? values?.values as Record<string, unknown> | undefined : values
            if (justUpgradePiece || !fieldsValue) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion: '0.2.10',
                    },
                }
            }
            let stepSettings = JSON.stringify({
                ...step.settings,
                qadamVersion: '0.2.10',
            })
            for (const [fieldId, externalId] of Object.entries(fieldIdToExternalId)) {
                stepSettings = stepSettings.replaceAll(`"${fieldId}"`, `"${externalId}"`)
            }

            return {
                ...step,
                settings: JSON.parse(stepSettings),
            }
        })

        return {
            ...newVersion,
            schemaVersion: '12',
        }
    },
}


function isTablesStep(step: Step): boolean {
    return step.type === FlowActionType.PIECE && step.settings.qadamName === TABLES_PIECE_NAME && (step.settings.qadamVersion.includes('0.1.') || step.settings.qadamVersion.includes('0.2.'))
}

function isOldTablesStep(step: Step): boolean {
    return isTablesStep(step) && step.settings.qadamVersion.includes('0.1.')
}