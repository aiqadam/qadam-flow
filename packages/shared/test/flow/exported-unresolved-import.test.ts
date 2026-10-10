import {
    FlowAction,
    FlowActionType,
    flowOperations,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    ImportFlowRequest,
} from '../../src'
import { _importFlow } from '../../src/lib/automation/flows/operations/import-flow'

// ADR-0004 "Export and import": the importer marks every step the exporter listed as
// exported-unresolved "update this step", even when the release its caret names exists.
describe('importing a flow with exported-unresolved steps', () => {
    it('marks a listed action with the exact pin it was imported on', () => {
        const imported = importFlow({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' })] })

        const marked = findAction({ version: imported, name: 'step_1' })
        expect(marked?.settings.qadamVersion).toBe('1.3.0')
        expect(marked?.settings.exportedUnresolvedPin).toBe('1.3.0')
    })

    it('marks a listed trigger', () => {
        const imported = importFlow({ unresolved: [unresolvedStep({ stepName: 'trigger', pin: '^1.3.0' })] })

        expect(imported.trigger.type === FlowTriggerType.PIECE && imported.trigger.settings.exportedUnresolvedPin).toBe('1.3.0')
    })

    it('leaves steps that are not listed unmarked', () => {
        const imported = importFlow({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' })] })

        expect(findAction({ version: imported, name: 'step_2' })?.settings.exportedUnresolvedPin).toBeUndefined()
        expect(imported.trigger.type === FlowTriggerType.PIECE && imported.trigger.settings.exportedUnresolvedPin).toBeUndefined()
    })

    it('marks nothing for a name the flow does not have, and for a step that is not a qadam step', () => {
        const imported = importFlow({ unresolved: [
            unresolvedStep({ stepName: 'step_9', pin: '^1.3.0' }),
            unresolvedStep({ stepName: 'code_step', pin: '^1.3.0' }),
        ] })

        const code = findStep({ version: imported, name: 'code_step' })
        expect(code?.type).toBe(FlowActionType.CODE)
        expect(JSON.stringify(imported)).not.toContain('exportedUnresolvedPin')
    })

    it('marks nothing when the listed qadam is not the step\'s qadam', () => {
        const imported = importFlow({ unresolved: [{ stepName: 'step_1', qadamName: '@aiqadam/qadam-other', pin: '^1.3.0' }] })

        expect(JSON.stringify(imported)).not.toContain('exportedUnresolvedPin')
    })

    it('drops a marker the file brought: only the importer writes one', () => {
        const request = importRequest({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' })] })
        const carried = findStepIn({ trigger: request.trigger, name: 'step_2' })
        if (carried?.type === FlowActionType.PIECE) {
            carried.settings.exportedUnresolvedPin = '1.2.0'
        }

        const imported = operationsFor({ request }).reduce((version, operation) => flowOperations.apply(version, operation), storedFlowVersion())

        expect(findAction({ version: imported, name: 'step_2' })?.settings.exportedUnresolvedPin).toBeUndefined()
        expect(findAction({ version: imported, name: 'step_1' })?.settings.exportedUnresolvedPin).toBe('1.3.0')
    })

    it('imports a flow with no list exactly as before', () => {
        const imported = importFlow({ unresolved: undefined })

        expect(JSON.stringify(imported)).not.toContain('exportedUnresolvedPin')
    })

    it('does not change the request it was given', () => {
        const request = importRequest({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' })] })

        _importFlow(storedFlowVersion(), request)

        expect(JSON.stringify(request.trigger)).not.toContain('exportedUnresolvedPin')
    })

    it('refuses a request whose list names a step badly or is oversized', () => {
        expect(ImportFlowRequest.safeParse(importRequest({ unresolved: [unresolvedStep({ stepName: '../etc', pin: '^1.3.0' })] })).success).toBe(false)
        expect(ImportFlowRequest.safeParse(importRequest({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '1.3.0-rc.1' })] })).success).toBe(false)
        const many = Array.from({ length: 10_001 }, () => unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' }))
        expect(ImportFlowRequest.safeParse(importRequest({ unresolved: many })).success).toBe(false)
    })

    it('keeps the mark through the stored-flow schema', () => {
        const imported = importFlow({ unresolved: [unresolvedStep({ stepName: 'step_1', pin: '^1.3.0' })] })

        const parsed = FlowVersion.safeParse(imported)

        expect(parsed.success).toBe(true)
        const action = parsed.success ? findAction({ version: parsed.data, name: 'step_1' }) : undefined
        expect(action?.settings.exportedUnresolvedPin).toBe('1.3.0')
    })
})

function importFlow({ unresolved }: { unresolved: ImportFlowRequest['exportedUnresolved'] }): FlowVersion {
    const target = storedFlowVersion()
    const operations = _importFlow(target, importRequest({ unresolved }))
    return operations.reduce((version, operation) => flowOperations.apply(version, operation), target)
}

function operationsFor({ request }: { request: ImportFlowRequest }): ReturnType<typeof _importFlow> {
    return _importFlow(storedFlowVersion(), request)
}

function findStepIn({ trigger, name }: { trigger: FlowTrigger, name: string }): FlowAction | undefined {
    for (let current: FlowAction | undefined = trigger.nextAction; current; current = current.nextAction) {
        if (current.name === name) {
            return current
        }
    }
    return undefined
}

function importRequest({ unresolved }: { unresolved: ImportFlowRequest['exportedUnresolved'] }): ImportFlowRequest {
    return {
        displayName: 'Imported',
        trigger: storedFlowVersion().trigger,
        schemaVersion: null,
        notes: [],
        exportedUnresolved: unresolved,
    }
}

function unresolvedStep({ stepName, pin }: { stepName: string, pin: string }): { stepName: string, qadamName: string, pin: string, reason: 'no-compatible-release' } {
    return { stepName, qadamName: '@aiqadam/qadam-tables', pin, reason: 'no-compatible-release' }
}

function findAction({ version, name }: { version: FlowVersion, name: string }): (FlowAction & { type: FlowActionType.PIECE }) | undefined {
    const action = findStep({ version, name })
    return action?.type === FlowActionType.PIECE ? action : undefined
}

function findStep({ version, name }: { version: FlowVersion, name: string }): FlowAction | undefined {
    let current: FlowAction | undefined = version.trigger.nextAction
    while (current) {
        if (current.name === name) {
            return current
        }
        current = current.nextAction
    }
    return undefined
}

function pieceAction({ name, qadamVersion }: { name: string, qadamVersion: string }): FlowAction {
    return {
        name,
        type: FlowActionType.PIECE,
        valid: true,
        displayName: name,
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: {
            qadamName: '@aiqadam/qadam-tables',
            qadamVersion,
            actionName: 'insert_record',
            propertySettings: {},
            input: {},
            errorHandlingOptions: {},
        },
    }
}

function storedFlowVersion(): FlowVersion {
    const code: FlowAction = {
        name: 'code_step',
        type: FlowActionType.CODE,
        valid: true,
        displayName: 'Code',
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: { sourceCode: { code: '', packageJson: '{}' }, input: {}, errorHandlingOptions: {} },
    }
    const trigger: FlowTrigger = {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        valid: true,
        displayName: 'Trigger',
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: {
            qadamName: '@aiqadam/qadam-tables',
            qadamVersion: '^1.3.0',
            triggerName: 'new_record',
            propertySettings: {},
            input: {},
        },
        nextAction: { ...pieceAction({ name: 'step_1', qadamVersion: '^1.3.0' }), nextAction: { ...pieceAction({ name: 'step_2', qadamVersion: '1.2.0' }), nextAction: code } },
    }
    return {
        id: 'pj0KQ7Aypoa9OQGHzmKDl',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        flowId: 'lod6JEdKyPlvrnErdnrGa',
        displayName: 'Unresolved pins',
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
        localeSource: null,
        trigger,
    }
}
