import { FlowActionType, FlowVersion } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockFind = vi.fn()
const mockGetOneById = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({ find: mockFind }),
}))

vi.mock('../../../../../src/app/flows/flow/flow.service', () => ({
    flowService: (): { getOneById: typeof mockGetOneById } => ({ getOneById: mockGetOneById }),
}))

import { migrateV11TablesToV2 } from '../../../../../src/app/flows/flow-version/migrations/migrate-v11-tables-to-v2'

const TABLES_QADAM_NAME = '@aiqadam/qadam-tables'
const OLD_TABLES_VERSION = '0.1.4'
const FIELD_ID = 'field-1'
const FIELD_EXTERNAL_ID = 'external-field-1'
const PROJECT_ID = 'project-1'

// A `tables-create-records` step on the pre-0.2 qadam, which is the shape this migration rewrites.
// The field ids are the KEYS of `input.values.values[]` — flow JSON, validated against nothing, so
// an id naming a field in another project reaches the lookup exactly like this one does.
function flowVersionWithCreateRecordsStep(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'create records flow',
        valid: true,
        schemaVersion: '11',
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
                displayName: 'Create Records',
                settings: {
                    qadamName: TABLES_QADAM_NAME,
                    qadamVersion: OLD_TABLES_VERSION,
                    actionName: 'tables-create-records',
                    input: {
                        values: {
                            values: [{ [FIELD_ID]: 'some value' }],
                        },
                    },
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readStepSettings(version: FlowVersion): { qadamVersion: string, input: { values: { values: Record<string, unknown>[] } } } {
    const chain = version.trigger as unknown as {
        nextAction: { settings: { qadamVersion: string, input: { values: { values: Record<string, unknown>[] } } } }
    }
    return chain.nextAction.settings
}

describe('migrateV11TablesToV2', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockFind.mockResolvedValue([{ id: FIELD_ID, externalId: FIELD_EXTERNAL_ID }])
        mockGetOneById.mockResolvedValue({ id: 'flow-1', projectId: PROJECT_ID })
    })

    it('starts at 11', () => {
        expect(migrateV11TablesToV2.targetSchemaVersion).toBe('11')
    })

    it('rewrites a field id to its external id and upgrades the qadam version', async () => {
        const migrated = await migrateV11TablesToV2.migrate(flowVersionWithCreateRecordsStep())

        const settings = readStepSettings(migrated)
        expect(Object.keys(settings.input.values.values[0] ?? {})).toEqual([FIELD_EXTERNAL_ID])
        expect(settings.qadamVersion).toBe('0.2.10')
        expect(migrated.schemaVersion).toBe('12')
    })

    // #488, the same data-isolation break as `migrate-v18`. Fails against the unfiltered query: the
    // `where` it passed carried only `id`, so a field id belonging to another project resolved and
    // that project's `externalId` was written into this flow version.
    it('scopes the field lookup to the flow own project', async () => {
        await migrateV11TablesToV2.migrate(flowVersionWithCreateRecordsStep())

        expect(mockFind).toHaveBeenCalledOnce()
        expect(mockFind.mock.calls[0]?.[0]).toMatchObject({ where: { projectId: PROJECT_ID } })
    })

    // Degrading, not throwing: `flow-version-migration.service.ts` pages on-call on any throw from
    // the chain, and on the template-import path the flow may not be in the database at all. The
    // qadam version upgrade — the rest of this migration's job — still has to happen.
    it('rewrites no id, rather than throwing, when the project cannot be determined', async () => {
        mockGetOneById.mockResolvedValue(null)

        const migrated = await migrateV11TablesToV2.migrate(flowVersionWithCreateRecordsStep())

        const settings = readStepSettings(migrated)
        expect(mockFind).not.toHaveBeenCalled()
        expect(Object.keys(settings.input.values.values[0] ?? {})).toEqual([FIELD_ID])
        expect(settings.qadamVersion).toBe('0.2.10')
        expect(migrated.schemaVersion).toBe('12')
    })

    // `tables-update-record` is the other entry in TARGET_ACTIONS and reads a different shape —
    // field ids sit directly on `input.values` rather than on `input.values.values[]`. It collects
    // ids through the same path the fix scopes, so leaving it uncovered would let half the change
    // regress unnoticed.
    it('scopes the lookup for tables-update-record too, whose values are shaped differently', async () => {
        const flowVersion = flowVersionWithCreateRecordsStep()
        const step = (flowVersion.trigger as unknown as { nextAction: { settings: Record<string, unknown> } }).nextAction
        step.settings.actionName = 'tables-update-record'
        step.settings.input = { values: { [FIELD_ID]: 'some value' } }

        const migrated = await migrateV11TablesToV2.migrate(flowVersion)

        expect(mockFind.mock.calls[0]?.[0]).toMatchObject({ where: { projectId: PROJECT_ID } })
        const values = (migrated.trigger as unknown as { nextAction: { settings: { input: { values: Record<string, unknown> } } } })
            .nextAction.settings.input.values
        expect(Object.keys(values)).toEqual([FIELD_EXTERNAL_ID])
    })

    it('rewrites no id when looking the flow up throws, rather than propagating', async () => {
        mockGetOneById.mockRejectedValue(new Error('flow row is gone'))

        const migrated = await migrateV11TablesToV2.migrate(flowVersionWithCreateRecordsStep())

        expect(mockFind).not.toHaveBeenCalled()
        expect(Object.keys(readStepSettings(migrated).input.values.values[0] ?? {})).toEqual([FIELD_ID])
    })
})
