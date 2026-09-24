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

        // `.agents/rules/data-isolation.md`: every query filters by `projectId`. Not a formality
        // here — `fieldIds` come straight from `step.settings.input.filters.filters[].field.id`,
        // and a PIECE step's `input` is `z.record(z.string(), z.unknown())` with no per-key
        // validation, so an id belonging to another project reaches this query untouched on the
        // `ap_import_flow` / `ap_duplicate_flow` path (`prepareRequest`'s IMPORT_FLOW case rewrites
        // only `notes`), and the migration then writes the other project's `externalId` into this
        // flow version where its owner can read it (#488).
        //
        // WHICH HALF OF THIS DEFENDS WHICH PATH, because they are not the same half. On a flow
        // version loaded from the database the `projectId` filter is what closes it. On the
        // IMPORT_FLOW path the filter never runs at all: `migrateFlowVersionTemplate` hardcodes
        // `flowId: ''`, so the resolve below always yields `undefined` and the degrade is the
        // entire defence. That is the path this is most needed on — `flow.controller.ts` invokes
        // it from `preValidation`, before the body is validated; before this change an
        // unauthenticated request reached an unfiltered field query there. The hook now
        // authorizes first, so only a member of the flow's project gets this far.
        //
        // An undeterminable project therefore resolves NOTHING rather than failing: the migration
        // still runs and still pins `qadamVersion` below, but every `field.id` is left exactly as
        // authored. Throwing instead would page on-call (`flow-version-migration.service.ts`) on
        // an ordinary template import. The visible cost, worth knowing: a schema-18 flow JSON
        // re-imported into the project that does own those fields keeps its raw ids and is stamped
        // past this migration, because the chain never re-enters a migration it has already run.
        // Fixing that means giving `migrateFlowVersionTemplate` a trustworthy project. The hook
        // now authorizes before migrating, so `request.projectId` is populated there; what is
        // left is threading it through the migration chain — a larger change than this one, and
        // not a regression in isolation terms.
        const projectId = await flowMigrationUtil.resolveProjectId({ flowId: flowVersion.flowId, flowVersionId: flowVersion.id, log: system.globalLogger() })
        const fields = isNil(projectId)
            ? []
            : await fieldRepo().find({
                where: { id: In([...new Set(fieldIds)]), projectId },
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
