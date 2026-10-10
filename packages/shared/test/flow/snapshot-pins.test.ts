import {
    FlowAction,
    FlowActionType,
    flowOperations,
    flowQadamUtil,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    ImportFlowRequest,
    qadamVersionParser,
    VersionType,
} from '../../src'
import { _importFlow } from '../../src/lib/automation/flows/operations/import-flow'

// ADR-0004 "Pin format" / #850: a step may pin a release `x.y.z` or a `-main.<n>` snapshot, each with
// an optional `^` or `~`, and no other prerelease. These are the stored-flow and import contracts.
const SNAPSHOT_PIN = '1.3.0-main.412'

describe('stored flows with snapshot pins', () => {
    it.each([
        ['an exact release', '1.2.3'],
        ['a caret release', '^1.2.3'],
        ['a tilde release', '~0.4.15'],
        ['an exact snapshot', SNAPSHOT_PIN],
        ['a caret snapshot', `^${SNAPSHOT_PIN}`],
        ['a tilde snapshot', `~${SNAPSHOT_PIN}`],
    ])('validates a flow version whose steps pin %s', (_label, qadamVersion) => {
        const result = FlowVersion.safeParse(storedFlowVersion({ qadamVersion }))

        expect(result.success).toBe(true)
    })

    it.each([
        ['another prerelease', '1.2.3-rc.1'],
        ['a snapshot without its counter', '1.2.3-main'],
        ['build metadata', '1.2.3+sha.abc'],
        ['a bare range', '>=1.2.3'],
        ['a dist-tag', 'latest'],
    ])('rejects a flow version whose steps pin %s', (_label, qadamVersion) => {
        const result = FlowVersion.safeParse(storedFlowVersion({ qadamVersion }))

        expect(result.success).toBe(false)
    })

    it('reads the same pins through the step-settings schemas and VersionType', () => {
        expect(VersionType.safeParse(`^${SNAPSHOT_PIN}`).success).toBe(true)
        expect(FlowTrigger.safeParse(storedFlowVersion({ qadamVersion: SNAPSHOT_PIN }).trigger).success).toBe(true)
        expect(FlowAction.safeParse(snapshotAction({ qadamVersion: `^${SNAPSHOT_PIN}` })).success).toBe(true)
        expect(FlowAction.safeParse(snapshotAction({ qadamVersion: '1.3.0-beta.1' })).success).toBe(false)
    })
})

describe('importing a flow that pins a snapshot', () => {
    it('strips the caret from a snapshot pin, as from a release pin, and the result is still an exact version', () => {
        const imported = importFlow({ qadamVersion: `^${SNAPSHOT_PIN}` })

        expect(imported.trigger.type === FlowTriggerType.PIECE && imported.trigger.settings.qadamVersion).toBe(SNAPSHOT_PIN)
        const action = imported.trigger.nextAction
        expect(action?.type === FlowActionType.PIECE && action.settings.qadamVersion).toBe(SNAPSHOT_PIN)
        expect(qadamVersionParser.isExact({ version: SNAPSHOT_PIN })).toBe(true)
    })

    it('strips a tilde the same way', () => {
        const imported = importFlow({ qadamVersion: `~${SNAPSHOT_PIN}` })

        const action = imported.trigger.nextAction
        expect(action?.type === FlowActionType.PIECE && action.settings.qadamVersion).toBe(SNAPSHOT_PIN)
    })

    it('leaves an exact snapshot pin as it is', () => {
        const imported = importFlow({ qadamVersion: SNAPSHOT_PIN })

        const action = imported.trigger.nextAction
        expect(action?.type === FlowActionType.PIECE && action.settings.qadamVersion).toBe(SNAPSHOT_PIN)
    })

    it('getExactVersion keeps the snapshot counter', () => {
        expect(flowQadamUtil.getExactVersion(`^${SNAPSHOT_PIN}`)).toBe(SNAPSHOT_PIN)
        expect(flowQadamUtil.getExactVersion(SNAPSHOT_PIN)).toBe(SNAPSHOT_PIN)
    })

    it('refuses an import request that pins another prerelease', () => {
        const request = importRequest({ qadamVersion: '^1.3.0-rc.1' })

        expect(ImportFlowRequest.safeParse(request).success).toBe(false)
    })
})

function importFlow({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    const target = storedFlowVersion({ qadamVersion: '0.0.1' })
    const operations = _importFlow(target, importRequest({ qadamVersion }))
    return operations.reduce((version, operation) => flowOperations.apply(version, operation), target)
}

function importRequest({ qadamVersion }: { qadamVersion: string }): ImportFlowRequest {
    const flowVersion = storedFlowVersion({ qadamVersion })
    return {
        displayName: 'Imported',
        trigger: flowVersion.trigger,
        schemaVersion: null,
        notes: [],
    }
}

function snapshotAction({ qadamVersion }: { qadamVersion: string }): FlowAction {
    return {
        name: 'step_1',
        type: FlowActionType.PIECE,
        valid: true,
        displayName: 'Create record',
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

function storedFlowVersion({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    return {
        id: 'pj0KQ7Aypoa9OQGHzmKDl',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        flowId: 'lod6JEdKyPlvrnErdnrGa',
        displayName: 'Snapshot pins',
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
        localeSource: null,
        trigger: {
            name: 'trigger',
            type: FlowTriggerType.PIECE,
            valid: true,
            displayName: 'Every day',
            lastUpdatedDate: '2026-10-10T00:00:00.000Z',
            settings: {
                qadamName: '@aiqadam/qadam-schedule',
                qadamVersion,
                triggerName: 'cron_expression',
                propertySettings: {},
                input: {},
            },
            nextAction: snapshotAction({ qadamVersion }),
        },
    }
}
