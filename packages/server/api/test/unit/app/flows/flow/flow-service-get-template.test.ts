import { FlowAction, FlowActionType, FlowOperationStatus, FlowStatus, FlowTriggerType, FlowVersion, FlowVersionState, PopulatedFlow } from '@aiqadam/shared'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { flowService } from '../../../../../src/app/flows/flow/flow.service'
import { SnapshotExportSources } from '../../../../../src/app/qadams/snapshot-export/snapshot-export-sources'
import { SnapshotExportMode } from '../../../../../src/app/qadams/snapshot-export/snapshot-pin-export'

// ADR-0004 "Export and import": `getTemplate` is where an export is rewritten, and the same
// function serves templates that never leave the instance, which must keep their pins.
const TABLES = '@aiqadam/qadam-tables'
const SNAPSHOT = '1.3.0-main.412'
const log = pino({ level: 'silent' })

describe('flowService.getTemplate and snapshot pins', () => {
    it('rewrites a snapshot pin in an export, and lists a step no release passed', async () => {
        const { template } = await getTemplate({ mode: SnapshotExportMode.REWRITE, releases: ['1.3.2'] })

        expect(pinsOf({ version: template.flows?.[0] })).toEqual(['1.3.2', '^1.3.0'])
        expect(template.flows?.[0]?.exportedUnresolved).toEqual([{ stepName: 'step_2', qadamName: TABLES, pin: SNAPSHOT }])
    })

    it('leaves the pins of a template that stays on the instance, and asks nothing of the catalogue', async () => {
        const { template, sources } = await getTemplate({ mode: SnapshotExportMode.SAME_INSTANCE, releases: ['1.3.2'] })

        expect(pinsOf({ version: template.flows?.[0] })).toEqual([SNAPSHOT, SNAPSHOT])
        expect(template.flows?.[0]?.exportedUnresolved).toBeUndefined()
        expect(sources.releases).not.toHaveBeenCalled()
    })

    it('keeps the pins and embeds metadata when the person exporting chose to', async () => {
        const { template } = await getTemplate({ mode: SnapshotExportMode.KEEP, releases: ['1.3.2'] })

        expect(pinsOf({ version: template.flows?.[0] })).toEqual([SNAPSHOT, SNAPSHOT])
        expect(Object.keys(template.flows?.[0]?.snapshotMetadata ?? {})).toEqual([`${TABLES}@${SNAPSHOT}`])
    })
})

async function getTemplate({ mode, releases }: { mode: SnapshotExportMode, releases: string[] }): Promise<{ template: Awaited<ReturnType<ReturnType<typeof flowService>['getTemplate']>>, sources: FakeSources }> {
    const service = flowService(log)
    vi.spyOn(service, 'getOnePopulatedOrThrow').mockResolvedValue(populatedFlow())
    const sources = fakeSources({ releases })
    const template = await service.getTemplate({ flowId: 'lod6JEdKyPlvrnErdnrGa', projectId: 'project', userMetadata: null, versionId: undefined, snapshotExportMode: mode, snapshotSources: sources })
    return { template, sources }
}

function pinsOf({ version }: { version: { trigger: FlowVersion['trigger'] } | undefined }): string[] {
    const pins: string[] = []
    for (let step = version?.trigger.nextAction; step; step = step.nextAction) {
        if (step.type === FlowActionType.PIECE) {
            pins.push(step.settings.qadamVersion)
        }
    }
    return pins
}

function fakeSources({ releases }: { releases: string[] }): FakeSources {
    const metadata = (props: Record<string, unknown>): unknown => ({ name: TABLES, version: SNAPSHOT, actions: { insert: { props }, other: { props: {} } }, triggers: {} })
    return {
        releases: vi.fn(async () => releases),
        // The release lacks `other`, so a step using it can never pass.
        releaseMetadata: vi.fn(async () => ({ actions: { insert: { props: {} } }, triggers: {} })),
        snapshotMetadata: vi.fn(async () => metadata({})),
    }
}

function populatedFlow(): PopulatedFlow {
    const step = (name: string, actionName: string, next?: FlowAction): FlowAction => ({
        name,
        type: FlowActionType.PIECE,
        valid: true,
        displayName: name,
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: { qadamName: TABLES, qadamVersion: SNAPSHOT, actionName, propertySettings: {}, input: {}, errorHandlingOptions: {} },
        nextAction: next,
    })
    const version: FlowVersion = {
        id: 'pj0KQ7Aypoa9OQGHzmKDl',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        flowId: 'lod6JEdKyPlvrnErdnrGa',
        displayName: 'Export',
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
            type: FlowTriggerType.EMPTY,
            valid: true,
            displayName: 'Trigger',
            lastUpdatedDate: '2026-10-10T00:00:00.000Z',
            settings: {},
            nextAction: step('step_1', 'insert', step('step_2', 'other')),
        },
    }
    return {
        id: 'lod6JEdKyPlvrnErdnrGa',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        projectId: 'project',
        externalId: 'ext',
        folderId: null,
        status: FlowStatus.DISABLED,
        publishedVersionId: null,
        operationStatus: FlowOperationStatus.NONE,
        metadata: null,
        ownerId: null,
        timeSavedPerRun: null,
        templateId: null,
        createdBy: null,
        version,
    }
}

type FakeSources = {
    releases: ReturnType<typeof vi.fn<SnapshotExportSources['releases']>>
    releaseMetadata: ReturnType<typeof vi.fn<SnapshotExportSources['releaseMetadata']>>
    snapshotMetadata: ReturnType<typeof vi.fn<SnapshotExportSources['snapshotMetadata']>>
}
