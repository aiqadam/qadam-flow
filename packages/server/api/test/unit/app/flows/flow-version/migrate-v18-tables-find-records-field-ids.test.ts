import { FlowActionType, FlowVersion } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFind = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({ find: mockFind }),
}))

import { migrateV18TablesFieldIds } from '../../../../../src/app/flows/flow-version/migrations/migrate-v18-tables-find-records-field-ids'

const TABLES_QADAM_NAME = '@aiqadam/qadam-tables'
const LEGIT_FIELD_ID = 'field-1'
const LEGIT_FIELD_EXTERNAL_ID = 'external-field-1'
const LEGIT_FIELD_VERSION = '0.2.9'

// A `tables-find-records` step whose one real filter (`LEGIT_FIELD_ID`) the migration is meant to
// resolve to an external id, plus a second filter literally naming its field `constructor` —
// `field.id` is read straight out of flow JSON (`QadamActionSettings.input` is
// `z.record(z.string(), z.unknown())`, and `ap_import_flow` never validates a PIECE step's `input`
// shape), so nothing stops a crafted flow from carrying that string. `fieldRepo().find` never
// returns a row for it (mirroring a field id that resolves to nothing), so a bare `Record` index
// for the replacement lookup reaches `Object.prototype` and hands back the `Object` constructor as
// its "external id" — passing the old truthiness check and getting written into the filter.
function flowVersionWithLegitFilterAndPrototypeNamedFieldId(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'prototype pollution guard flow',
        valid: true,
        schemaVersion: '18',
        state: 'DRAFT',
        trigger: {
            name: 'trigger',
            type: 'EMPTY',
            valid: true,
            displayName: 'Select Trigger',
            settings: {},
            nextAction: {
                name: 'step_1',
                type: FlowActionType.PIECE,
                valid: true,
                displayName: 'Find Records',
                settings: {
                    qadamName: TABLES_QADAM_NAME,
                    qadamVersion: LEGIT_FIELD_VERSION,
                    actionName: 'tables-find-records',
                    input: {
                        filters: {
                            filters: [
                                { field: { id: LEGIT_FIELD_ID } },
                                { field: { id: 'constructor' } },
                            ],
                        },
                    },
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readFilters(version: FlowVersion): { id: unknown }[] {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { input: { filters: { filters: { field: { id: unknown } }[] } } } }
    }
    return chain.nextAction.settings.input.filters.filters.map(filter => filter.field)
}

describe('migrateV18TablesFieldIds', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockFind.mockResolvedValue([{ id: LEGIT_FIELD_ID, externalId: LEGIT_FIELD_EXTERNAL_ID }])
    })

    it('starts at 18', () => {
        expect(migrateV18TablesFieldIds.targetSchemaVersion).toBe('18')
    })

    it('resolves a real filter field id to its external id', async () => {
        const migrated = await migrateV18TablesFieldIds.migrate(flowVersionWithLegitFilterAndPrototypeNamedFieldId())

        expect(readFilters(migrated)[0].id).toBe(LEGIT_FIELD_EXTERNAL_ID)
        expect(migrated.schemaVersion).toBe('19')
    })

    // Blocking finding: a bare `Record` index hits `Object.prototype` for a filter field id
    // literally named `constructor`, even though the DB lookup never returned a row for it. This
    // must fail on a `Record`-based implementation (the "external id" for that filter resolves to
    // the `Object` constructor function, not `undefined`, so the truthiness check lets it through
    // and the filter's `field.id` is overwritten with it) and pass with a `Map`.
    it('does not corrupt a filter field literally named "constructor" while resolving a real filter in the same step', async () => {
        const migrated = await migrateV18TablesFieldIds.migrate(flowVersionWithLegitFilterAndPrototypeNamedFieldId())

        const prototypeNamedFilterId = readFilters(migrated)[1].id
        expect(prototypeNamedFilterId).toBe('constructor')
        expect(typeof prototypeNamedFilterId).toBe('string')
    })
})
