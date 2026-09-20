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
import { FieldEntity } from '../../../tables/field/field.entity'
import { Migration } from '.'

const fieldRepo = repoFactory<Field>(FieldEntity)

const TABLES_PIECE_NAME = '@aiqadam/qadam-tables'
const TABLES_PIECE_VERSION = '0.3.0'
const FIND_RECORDS_ACTION = 'tables-find-records'

function collectFieldIdsFromFilters(flowVersion: FlowVersion): string[] {
    const fieldIds: string[] = []

    flowStructureUtil.getAllSteps(flowVersion.trigger).forEach((step) => {
        if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== TABLES_PIECE_NAME) {
            return
        }
        if (step.settings.actionName !== FIND_RECORDS_ACTION) {
            return
        }

        const input = step.settings?.input as Record<string, unknown> | undefined
        const filters = input?.filters as Record<string, unknown> | undefined
        const filtersArray = filters?.filters as { field?: { id?: string } }[] | undefined
        if (!Array.isArray(filtersArray)) {
            return
        }

        for (const filter of filtersArray) {
            if (filter.field?.id) {
                fieldIds.push(filter.field.id)
            }
        }
    })

    return fieldIds
}

export const migrateV18TablesFieldIds: Migration = {
    targetSchemaVersion: '18',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const fieldIds = collectFieldIdsFromFilters(flowVersion)
        if (fieldIds.length === 0) {
            return {
                ...flowVersion,
                schemaVersion: '19',
            }
        }

        const fields = await fieldRepo().find({
            where: { id: In([...new Set(fieldIds)]) },
        })

        // A `Map`, not a `Record`: `filter.field.id` comes straight from
        // `step.settings.input.filters.filters[].field.id`, i.e. flow JSON that is never
        // constrained to an actual field id — `QadamActionSettings.input` is `z.record(z.string(),
        // z.unknown())` and `ap_import_flow`/IMPORT_FLOW does not validate a PIECE step's `input`
        // shape. A crafted `field.id: "constructor"` on a bare `Record` reaches `Object.prototype`
        // and hands back the `Object` constructor, which passes the truthiness check below and
        // gets written into the filter's field reference — dropped silently on JSONB
        // serialisation. Same idiom as the `hasOwn`, not a bare index guard in
        // `ap-validate-flow.ts`'s delay-unit lookup.
        const fieldIdToExternalId = new Map<string, string>()
        for (const field of fields) {
            fieldIdToExternalId.set(field.id, field.externalId)
        }

        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step: Step) => {
            if (step.type !== FlowActionType.PIECE || step.settings.qadamName !== TABLES_PIECE_NAME) {
                return step
            }

            if (step.settings.actionName !== FIND_RECORDS_ACTION) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion: TABLES_PIECE_VERSION,
                    },
                }
            }

            const input = step.settings?.input as Record<string, unknown> | undefined
            const filters = input?.filters as Record<string, unknown> | undefined
            const filtersArray = filters?.filters as { field?: { id?: string, type?: string, name?: string } }[] | undefined
            if (!Array.isArray(filtersArray)) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion: TABLES_PIECE_VERSION,
                    },
                }
            }

            const migratedFilters = filtersArray.map((filter) => {
                const externalId = isNil(filter.field?.id) ? undefined : fieldIdToExternalId.get(filter.field.id)
                if (isNil(externalId)) {
                    return filter
                }
                return {
                    ...filter,
                    field: {
                        ...filter.field,
                        id: externalId,
                    },
                }
            })

            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: TABLES_PIECE_VERSION,
                    input: {
                        ...input,
                        filters: {
                            ...filters,
                            filters: migratedFilters,
                        },
                    },
                },
            }
        })

        return {
            ...newVersion,
            schemaVersion: '19',
        }
    },
}
