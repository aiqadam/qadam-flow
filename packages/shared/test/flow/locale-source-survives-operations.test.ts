import {
    FlowOperationRequest,
    flowOperations,
    FlowOperationType,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    LOCALE_SOURCE_MAX_LENGTH,
    UpdateLocaleSourceRequest,
} from '../../src'
import { _importFlow } from '../../src/lib/automation/flows/operations/import-flow'

const baseFlowVersion: FlowVersion = {
    notes: [],
    id: 'pj0KQ7Aypoa9OQGHzmKDl',
    created: '2023-05-24T00:16:41.353Z',
    updated: '2023-05-24T00:16:41.353Z',
    flowId: 'lod6JEdKyPlvrnErdnrGa',
    displayName: 'localeSource survival',
    updatedBy: '',
    agentIds: [],
    trigger: {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        valid: true,
        settings: {
            input: {
                cronExpression: '25 10 * * 0,1,2,3,4',
            },
            qadamName: 'schedule',
            qadamVersion: '0.0.2',
            propertySettings: {},
            triggerName: 'cron_expression',
        },
        displayName: 'Cron Expression',
    },
    valid: true,
    state: FlowVersionState.DRAFT,
    connectionIds: [],
    localeSource: '{{trigger[\'output\'].lang}}',
}

describe('UPDATE_LOCALE_SOURCE', () => {
    it('sets localeSource on the flow version', () => {
        const operation: FlowOperationRequest = {
            type: FlowOperationType.UPDATE_LOCALE_SOURCE,
            request: { localeSource: 'ru' },
        }
        const result = flowOperations.apply({ ...baseFlowVersion, localeSource: null }, operation)
        expect(result.localeSource).toBe('ru')
    })

    it('clears localeSource back to null', () => {
        const operation: FlowOperationRequest = {
            type: FlowOperationType.UPDATE_LOCALE_SOURCE,
            request: { localeSource: null },
        }
        const result = flowOperations.apply(baseFlowVersion, operation)
        expect(result.localeSource).toBeNull()
    })

    it('rejects a localeSource longer than LOCALE_SOURCE_MAX_LENGTH', () => {
        const result = UpdateLocaleSourceRequest.safeParse({ localeSource: 'a'.repeat(LOCALE_SOURCE_MAX_LENGTH + 1) })
        expect(result.success).toBe(false)
    })

    it('accepts a localeSource at exactly LOCALE_SOURCE_MAX_LENGTH', () => {
        const result = UpdateLocaleSourceRequest.safeParse({ localeSource: 'a'.repeat(LOCALE_SOURCE_MAX_LENGTH) })
        expect(result.success).toBe(true)
    })
})

// #420 review M1: `_importFlow` used to coalesce an absent `localeSource` (a caller expressing no
// opinion — a duplicate/use-as-draft path that never carried it forward) to `null`, silently
// wiping the target's existing value on every import that omitted the field.
describe('IMPORT_FLOW carries/clears localeSource explicitly, never implicitly', () => {
    it('omitting localeSource from the import request leaves the target version\'s existing value untouched', () => {
        const operations = _importFlow(baseFlowVersion, {
            displayName: 'Imported',
            trigger: baseFlowVersion.trigger,
            schemaVersion: baseFlowVersion.schemaVersion ?? null,
            notes: [],
        })
        expect(operations.some((op) => op.type === FlowOperationType.UPDATE_LOCALE_SOURCE)).toBe(false)

        let result = baseFlowVersion
        for (const operation of operations) {
            result = flowOperations.apply(result, operation)
        }
        expect(result.localeSource).toBe('{{trigger[\'output\'].lang}}')
    })

    it('an explicit localeSource: null in the import request clears the target\'s existing value', () => {
        const operations = _importFlow(baseFlowVersion, {
            displayName: 'Imported',
            trigger: baseFlowVersion.trigger,
            schemaVersion: baseFlowVersion.schemaVersion ?? null,
            notes: [],
            localeSource: null,
        })
        expect(operations.some((op) => op.type === FlowOperationType.UPDATE_LOCALE_SOURCE)).toBe(true)

        let result = baseFlowVersion
        for (const operation of operations) {
            result = flowOperations.apply(result, operation)
        }
        expect(result.localeSource).toBeNull()
    })

    it('an explicit localeSource string in the import request sets it on the target', () => {
        const operations = _importFlow({ ...baseFlowVersion, localeSource: null }, {
            displayName: 'Imported',
            trigger: baseFlowVersion.trigger,
            schemaVersion: baseFlowVersion.schemaVersion ?? null,
            notes: [],
            localeSource: 'fr',
        })

        let result = { ...baseFlowVersion, localeSource: null }
        for (const operation of operations) {
            result = flowOperations.apply(result, operation)
        }
        expect(result.localeSource).toBe('fr')
    })
})
