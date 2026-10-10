import { AgentToolType, FlowAction, FlowActionType, flowStructureUtil, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState } from '@aiqadam/shared'
import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotExportSources } from '../../../../src/app/qadams/snapshot-export/snapshot-export-sources'
import { MAX_RELEASE_FETCHES_PER_EXPORT, MAX_RELEASES_CHECKED_PER_PIN, MAX_SNAPSHOT_READS_PER_EXPORT, SnapshotExportMode, snapshotPinExport } from '../../../../src/app/qadams/snapshot-export/snapshot-pin-export'

// ADR-0004 "Export and import". The sources are a fake catalogue and a fake instance store: the
// catalogue is not wired at run time yet, so these are the contract the real binding must meet.
const TABLES = '@aiqadam/qadam-tables'
const CSV = '@aiqadam/qadam-csv'
const SNAPSHOT = '1.3.0-main.412'
const log = pino({ level: 'silent' })

describe('snapshotPinExport.apply, rewrite (an export that leaves the instance)', () => {
    it('moves a snapshot pin to the newest release at or above its base, inside its caret range, that passes the props check', async () => {
        const sources = fakeSources({
            releases: { [TABLES]: ['1.2.9', '1.3.0', '1.3.1', '1.3.2', '1.4.0', '2.0.0', '1.3.3-main.9'] },
            release: { '1.3.0': compatible(), '1.3.1': compatible(), '1.3.2': incompatible(), '1.4.0': incompatible(), '2.0.0': compatible(), '1.2.9': compatible(), '1.3.3-main.9': compatible() },
        })

        const exported = await rewrite({ pin: SNAPSHOT, sources })

        expect(pinOf({ version: exported, name: 'step_1' })).toBe('1.3.1')
        expect(exported.exportedUnresolved).toBeUndefined()
    })

    it('takes the newest release when it passes, even on a later minor line', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.0', '1.3.2', '1.4.0'] }, release: { '1.3.0': compatible(), '1.3.2': compatible(), '1.4.0': compatible() } })

        expect(pinOf({ version: await rewrite({ pin: SNAPSHOT, sources }), name: 'step_1' })).toBe('1.4.0')
    })

    it('never goes below the base or across the caret, and flags the step when nothing is left', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.2.4', '2.0.0'] }, release: { '1.2.4': compatible(), '2.0.0': compatible() } })

        const exported = await rewrite({ pin: SNAPSHOT, sources })

        expect(pinOf({ version: exported, name: 'step_1' })).toBe('^1.3.0')
        expect(exported.exportedUnresolved).toEqual([{ stepName: 'step_1', qadamName: TABLES, pin: SNAPSHOT, reason: 'no-compatible-release' }])
    })

    it('on 0.x stays inside the minor', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['0.6.3', '0.7.0'] }, release: { '0.6.3': compatible(), '0.7.0': compatible() } })

        expect(pinOf({ version: await rewrite({ pin: '0.6.0-main.5', sources }), name: 'step_1' })).toBe('0.6.3')
    })

    it('keeps the range prefix the pin had', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.0'] }, release: { '1.3.0': compatible() } })

        expect(pinOf({ version: await rewrite({ pin: `^${SNAPSHOT}`, sources }), name: 'step_1' })).toBe('^1.3.0')
    })

    it('flags the step as ^<base> when no release passes the props check', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.0', '1.3.1'] }, release: { '1.3.0': incompatible(), '1.3.1': incompatible() } })

        const exported = await rewrite({ pin: SNAPSHOT, sources })

        expect(pinOf({ version: exported, name: 'step_1' })).toBe('^1.3.0')
        expect(exported.exportedUnresolved).toEqual([{ stepName: 'step_1', qadamName: TABLES, pin: SNAPSHOT, reason: 'no-compatible-release' }])
    })

    it.each([
        ['the instance holds no metadata for the snapshot', fakeSources({ snapshot: null, releases: { [TABLES]: ['1.3.0'] }, release: { '1.3.0': compatible() } }), 'metadata-unavailable'],
        ['the catalogue cannot be read', fakeSources({ releases: null, release: {} }), 'catalogue-unavailable'],
        ['the catalogue lists no release of the qadam', fakeSources({ releases: {}, release: {} }), 'no-compatible-release'],
        ['the catalogue has no metadata for the release', fakeSources({ releases: { [TABLES]: ['1.3.0'] }, release: {} }), 'metadata-unavailable'],
    ])('flags the step when %s: a pin is never moved on information the instance lacks', async (_label, sources, reason) => {
        const exported = await rewrite({ pin: SNAPSHOT, sources })

        expect(pinOf({ version: exported, name: 'step_1' })).toBe('^1.3.0')
        expect(exported.exportedUnresolved).toEqual([{ stepName: 'step_1', qadamName: TABLES, pin: SNAPSHOT, reason }])
    })

    it('flags a step whose action is not named, because the check has nothing to compare', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.0'] }, release: { '1.3.0': compatible() } })

        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: undefined }] }), mode: SnapshotExportMode.REWRITE, sources, log })

        expect(exported.exportedUnresolved).toHaveLength(1)
    })

    it('checks a trigger against the trigger it uses', async () => {
        const sources = fakeSources({
            releases: { [TABLES]: ['1.3.1'] },
            snapshot: { actions: {}, triggers: { new_row: { props: { a: { type: 'SHORT_TEXT', required: false } } } } },
            release: { '1.3.1': { actions: {}, triggers: { new_row: { props: { a: { type: 'SHORT_TEXT', required: false } } } } } },
        })

        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ trigger: { qadamName: TABLES, qadamVersion: SNAPSHOT, triggerName: 'new_row' }, steps: [] }), mode: SnapshotExportMode.REWRITE, sources, log })

        expect(exported.trigger.type === FlowTriggerType.PIECE && exported.trigger.settings.qadamVersion).toBe('1.3.1')
    })

    it('leaves release pins, caret release pins and code steps alone and asks nothing of the sources for them', async () => {
        const sources = fakeSources({ releases: {}, release: {} })
        const version = flowVersion({ steps: [
            { name: 'step_1', qadamName: TABLES, qadamVersion: '1.2.0', actionName: 'insert' },
            { name: 'step_2', qadamName: CSV, qadamVersion: '^0.4.1', actionName: 'insert' },
        ] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(exported).toEqual(version)
        expect(sources.releases).not.toHaveBeenCalled()
        expect(sources.snapshotMetadata).not.toHaveBeenCalled()
    })

    it('resolves each distinct pin once however many steps carry it, and every step gets the answer', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const version = flowVersion({ steps: [
            { name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' },
            { name: 'step_2', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' },
            { name: 'step_3', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' },
        ] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(['step_1', 'step_2', 'step_3'].map((name) => pinOf({ version: exported, name }))).toEqual(['1.3.1', '1.3.1', '1.3.1'])
        expect(sources.snapshotMetadata).toHaveBeenCalledTimes(1)
        expect(sources.releaseMetadata).toHaveBeenCalledTimes(1)
    })

    it('changes the exported copy only', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' }] })
        const before = JSON.stringify(version)

        await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(JSON.stringify(version)).toBe(before)
    })

    it('bounds how many releases it fetches metadata for', async () => {
        const releases = Array.from({ length: 60 }, (_, index) => `1.3.${index}`)
        const sources = fakeSources({ releases: { [TABLES]: releases }, release: Object.fromEntries(releases.map((version) => [version, incompatible()])) })

        await rewrite({ pin: SNAPSHOT, sources })

        expect(sources.releaseMetadata).toHaveBeenCalledTimes(MAX_RELEASES_CHECKED_PER_PIN)
    })
})

describe('snapshotPinExport.apply, same instance', () => {
    it('leaves every pin as it is and adds nothing', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' }] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.SAME_INSTANCE, sources, log })

        expect(exported).toEqual(version)
        expect(sources.releases).not.toHaveBeenCalled()
    })
})

describe('snapshotPinExport.apply, keep snapshots (the explicit opt-in)', () => {
    it('keeps the pins and embeds each kept snapshot metadata.json once, keyed name@version', async () => {
        const sources = fakeSources({ releases: {}, release: {} })
        const version = flowVersion({ steps: [
            { name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' },
            { name: 'step_2', qadamName: TABLES, qadamVersion: `^${SNAPSHOT}`, actionName: 'insert' },
            { name: 'step_3', qadamName: CSV, qadamVersion: '0.4.1', actionName: 'insert' },
        ] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.KEEP, sources, log })

        expect(exported.trigger).toEqual(version.trigger)
        expect(Object.keys(exported.snapshotMetadata ?? {})).toEqual([`${TABLES}@${SNAPSHOT}`])
        expect(exported.snapshotMetadata?.[`${TABLES}@${SNAPSHOT}`]).toMatchObject({ name: TABLES, version: SNAPSHOT, actions: { insert: { props: { a: { type: 'SHORT_TEXT' } } } } })
        expect(sources.snapshotMetadata).toHaveBeenCalledTimes(1)
        expect(sources.releases).not.toHaveBeenCalled()
        expect(exported.exportedUnresolved).toBeUndefined()
    })

    it('embeds nothing for metadata the instance does not hold, or that is not usable', async () => {
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert' }] })

        for (const snapshot of [null, { name: TABLES, version: '1.3.0-main.1', actions: {}, triggers: {} }, 'x']) {
            const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.KEEP, sources: fakeSources({ snapshot, releases: {}, release: {} }), log })

            expect(exported.snapshotMetadata).toBeUndefined()
            expect(exported.trigger).toEqual(version.trigger)
        }
    })

    it('adds nothing to a flow without snapshot pins', async () => {
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: '1.2.0', actionName: 'insert' }] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.KEEP, sources: fakeSources({ releases: {}, release: {} }), log })

        expect(exported).toEqual(version)
    })
})

describe('snapshotPinExport.apply, the cost of one export', () => {
    it('fetches each release metadata at most once however many actions of one snapshot the flow uses', async () => {
        const actions = Array.from({ length: 10 }, (_, index) => `action_${index}`)
        const sources = fakeSources({ snapshot: compatible({ actions }), releases: { [TABLES]: ['1.3.1', '1.3.2', '1.3.3'] }, release: { '1.3.1': incompatible(), '1.3.2': incompatible(), '1.3.3': incompatible() } })
        const version = flowVersion({ steps: actions.map((actionName, index) => ({ name: `step_${index + 1}`, qadamName: TABLES, qadamVersion: SNAPSHOT, actionName })) })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(exported.exportedUnresolved).toHaveLength(10)
        expect(sources.snapshotMetadata).toHaveBeenCalledTimes(1)
        expect(sources.releaseMetadata).toHaveBeenCalledTimes(3)
    })

    it('fetches no release at all for an action the snapshot does not describe', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const version = flowVersion({ steps: Array.from({ length: 5 }, (_, index) => ({ name: `step_${index + 1}`, qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: `made_up_${index}` })) })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(exported.exportedUnresolved?.map((step) => step.reason)).toEqual(Array(5).fill('not-describable'))
        expect(sources.releases).not.toHaveBeenCalled()
        expect(sources.releaseMetadata).not.toHaveBeenCalled()
    })

    it('stops fetching when the budget of the export is spent, and exports the remaining pins as unresolved', async () => {
        const qadams = ['@aiqadam/qadam-a', '@aiqadam/qadam-b', '@aiqadam/qadam-c']
        const versions = Array.from({ length: MAX_RELEASES_CHECKED_PER_PIN }, (_, index) => `1.3.${index + 1}`)
        const sources = fakeSources({
            releases: Object.fromEntries(qadams.map((name) => [name, versions])),
            release: Object.fromEntries(versions.map((version) => [version, incompatible()])),
        })
        const version = flowVersion({ steps: qadams.map((qadamName, index) => ({ name: `step_${index + 1}`, qadamName, qadamVersion: SNAPSHOT, actionName: 'insert' })) })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(sources.releaseMetadata.mock.calls.length).toBeLessThanOrEqual(MAX_RELEASE_FETCHES_PER_EXPORT)
        expect(exported.exportedUnresolved).toHaveLength(3)
        expect(exported.exportedUnresolved?.map((step) => step.reason)).toContain('metadata-unavailable')
        expect(['step_1', 'step_2', 'step_3'].map((name) => pinOf({ version: exported, name }))).toEqual(['^1.3.0', '^1.3.0', '^1.3.0'])
    })
})

describe('snapshotPinExport.apply, snapshot reads', () => {
    it('reads at most the allowed number of distinct snapshots, and lists the pins it did not read', async () => {
        const count = MAX_SNAPSHOT_READS_PER_EXPORT + 6
        const steps = Array.from({ length: count }, (_, index) => ({ name: `step_${index + 1}`, qadamName: TABLES, qadamVersion: `1.3.0-main.${index + 1}`, actionName: 'insert' }))
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })

        const warn = vi.spyOn(log, 'warn')

        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ steps }), mode: SnapshotExportMode.REWRITE, sources, log })

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ exhausted: ['snapshot-reads'], maxReleaseFetches: MAX_RELEASE_FETCHES_PER_EXPORT, maxSnapshotReads: MAX_SNAPSHOT_READS_PER_EXPORT }),
            expect.stringContaining('budget'),
        )
        warn.mockRestore()
        expect(sources.snapshotMetadata).toHaveBeenCalledTimes(MAX_SNAPSHOT_READS_PER_EXPORT)
        expect(exported.exportedUnresolved).toHaveLength(6)
        expect(new Set(exported.exportedUnresolved?.map((step) => step.reason))).toEqual(new Set(['metadata-unavailable']))
    })
})

describe('snapshotPinExport.apply, the pin range', () => {
    it('keeps a tilde pin on its minor, and its tilde on the fallback', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.5', '1.4.0'] }, release: { '1.3.5': compatible(), '1.4.0': compatible() } })

        expect(pinOf({ version: await rewrite({ pin: '~1.3.0-main.5', sources }), name: 'step_1' })).toBe('~1.3.5')

        const noMinorRelease = fakeSources({ releases: { [TABLES]: ['1.4.0'] }, release: { '1.4.0': compatible() } })
        const exported = await rewrite({ pin: '~1.3.0-main.5', sources: noMinorRelease })

        expect(pinOf({ version: exported, name: 'step_1' })).toBe('~1.3.0')
        expect(exported.exportedUnresolved).toHaveLength(1)
    })
})

describe('snapshotPinExport.apply, agent tools', () => {
    const tool = (qadamVersion: string, actionName = 'insert'): unknown => ({ type: AgentToolType.PIECE, toolName: 'insert_row', qadamMetadata: { qadamName: TABLES, qadamVersion, actionName } })
    const agentStep = (tools: unknown[]): StepFixture => ({ name: 'agent_1', qadamName: '@aiqadam/qadam-ai', qadamVersion: '0.5.0', actionName: 'run_agent', tools })
    const toolsOf = ({ version }: { version: FlowVersion }): unknown[] => {
        const step = flowStructureUtil.getAllSteps(version.trigger).find((candidate) => candidate.name === 'agent_1')
        return step?.type === FlowActionType.PIECE && Array.isArray(step.settings.input['agentTools']) ? step.settings.input['agentTools'] : []
    }

    it('rewrites a snapshot pin in an agent tool like a step, and leaves the others', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const version = flowVersion({ steps: [agentStep([tool(SNAPSHOT), tool('1.2.0'), { type: 'MCP', toolName: 'x' }, 'junk'])] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources, log })

        expect(toolsOf({ version: exported })).toEqual([tool('1.3.1'), tool('1.2.0'), { type: 'MCP', toolName: 'x' }, 'junk'])
        expect(exported.exportedUnresolved).toBeUndefined()
    })

    it('lists a tool no release could be confirmed for, and exports it as ^<base>', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': incompatible() } })

        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ steps: [agentStep([tool(SNAPSHOT)])] }), mode: SnapshotExportMode.REWRITE, sources, log })

        expect(toolsOf({ version: exported })).toEqual([tool('^1.3.0')])
        expect(exported.exportedUnresolved).toEqual([{ stepName: 'agent_1', qadamName: TABLES, pin: SNAPSHOT, reason: 'no-compatible-release' }])
    })

    it('keeps a tool pin as it is when snapshots are kept, and embeds its metadata', async () => {
        const version = flowVersion({ steps: [agentStep([tool(SNAPSHOT)])] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.KEEP, sources: fakeSources({ releases: {}, release: {} }), log })

        expect(toolsOf({ version: exported })).toEqual([tool(SNAPSHOT)])
        expect(Object.keys(exported.snapshotMetadata ?? {})).toEqual([`${TABLES}@${SNAPSHOT}`])
    })

    it('keeps stray keys of the stored tool when it rewrites the pin', async () => {
        const sources = fakeSources({ releases: { [TABLES]: ['1.3.1'] }, release: { '1.3.1': compatible() } })
        const stray = { type: AgentToolType.PIECE, toolName: 'insert_row', note: 'kept', qadamMetadata: { qadamName: TABLES, qadamVersion: SNAPSHOT, actionName: 'insert', extra: 1 } }

        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ steps: [agentStep([stray])] }), mode: SnapshotExportMode.REWRITE, sources, log })

        expect(toolsOf({ version: exported })).toEqual([{ ...stray, qadamMetadata: { ...stray.qadamMetadata, qadamVersion: '1.3.1' } }])
    })

    it('does not touch the stored flow', async () => {
        const version = flowVersion({ steps: [agentStep([tool(SNAPSHOT)])] })
        const before = JSON.stringify(version)

        await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.REWRITE, sources: fakeSources({ releases: {}, release: {} }), log })

        expect(JSON.stringify(version)).toBe(before)
    })
})

describe('snapshotPinExport.apply, markers', () => {
    it.each([SnapshotExportMode.REWRITE, SnapshotExportMode.KEEP])('drops a marker the flow carried when it leaves the instance (%s)', async (mode) => {
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: '1.2.0', actionName: 'insert', marker: '1.2.0' }] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode, sources: fakeSources({ releases: {}, release: {} }), log })

        expect(JSON.stringify(exported)).not.toContain('exportedUnresolvedPin')
    })

    it('keeps it on a template that stays on the instance', async () => {
        const version = flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: '1.2.0', actionName: 'insert', marker: '1.2.0' }] })

        const exported = await snapshotPinExport.apply({ flowVersion: version, mode: SnapshotExportMode.SAME_INSTANCE, sources: fakeSources({ releases: {}, release: {} }), log })

        expect(JSON.stringify(exported)).toContain('exportedUnresolvedPin')
    })
})

describe('snapshotPinExport.modeFor', () => {
    it.each([
        [{}, SnapshotExportMode.REWRITE],
        [{ keepSnapshots: true }, SnapshotExportMode.KEEP],
        [{ keepSnapshots: false }, SnapshotExportMode.REWRITE],
        [{ sameInstance: true }, SnapshotExportMode.SAME_INSTANCE],
        [{ sameInstance: true, keepSnapshots: true }, SnapshotExportMode.SAME_INSTANCE],
        [{ sameInstance: false, keepSnapshots: true }, SnapshotExportMode.KEEP],
    ])('%j -> %s', (query, expected) => {
        expect(snapshotPinExport.modeFor(query)).toBe(expected)
    })
})

function rewrite({ pin, sources }: { pin: string, sources: SnapshotExportSources }): Promise<ExportResult> {
    return snapshotPinExport.apply({
        flowVersion: flowVersion({ steps: [{ name: 'step_1', qadamName: TABLES, qadamVersion: pin, actionName: 'insert' }] }),
        mode: SnapshotExportMode.REWRITE,
        sources,
        log,
    })
}

function pinOf({ version, name }: { version: FlowVersion, name: string }): string | undefined {
    const step = flowStructureUtil.getAllSteps(version.trigger).find((candidate) => candidate.name === name)
    return step?.type === FlowActionType.PIECE ? step.settings.qadamVersion : undefined
}

function compatible({ actions = [] }: { actions?: string[] } = {}): unknown {
    const props = { a: { type: 'SHORT_TEXT', required: false } }
    return { actions: Object.fromEntries(['insert', ...actions].map((name) => [name, { props }])), triggers: {} }
}

function incompatible(): unknown {
    return { actions: { insert: { props: {} } }, triggers: {} }
}

function fakeSources({ snapshot = compatible(), releases, release }: { snapshot?: unknown, releases: Record<string, string[]> | null, release: Record<string, unknown> }): FakeSources {
    return {
        releases: vi.fn(async ({ name }: { name: string }) => releases === null ? null : releases[name] ?? []),
        releaseMetadata: vi.fn(async ({ version }: { name: string, version: string }) => release[version] ?? null),
        snapshotMetadata: vi.fn(async ({ name, version }: { name: string, version: string }) => {
            const own = typeof snapshot === 'object' && snapshot !== null && 'actions' in snapshot ? { name, version, ...snapshot } : snapshot
            return own
        }),
    }
}

function flowVersion({ trigger, steps }: { trigger?: { qadamName: string, qadamVersion: string, triggerName: string }, steps: StepFixture[] }): FlowVersion {
    const actions = steps.reduceRight<FlowAction | undefined>((next, step) => ({
        name: step.name,
        type: FlowActionType.PIECE,
        valid: true,
        displayName: step.name,
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: { qadamName: step.qadamName, qadamVersion: step.qadamVersion, actionName: step.actionName, propertySettings: {}, input: step.tools === undefined ? {} : { agentTools: step.tools }, errorHandlingOptions: {}, exportedUnresolvedPin: step.marker },
        nextAction: next,
    }), undefined)
    const root: FlowTrigger = {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        valid: true,
        displayName: 'Trigger',
        lastUpdatedDate: '2026-10-10T00:00:00.000Z',
        settings: { qadamName: trigger?.qadamName ?? CSV, qadamVersion: trigger?.qadamVersion ?? '0.4.1', triggerName: trigger?.triggerName ?? 'new_row', propertySettings: {}, input: {} },
        nextAction: actions,
    }
    return {
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
        trigger: root,
    }
}

type StepFixture = { name: string, qadamName: string, qadamVersion: string, actionName: string | undefined, tools?: unknown[], marker?: string }

type ExportResult = Awaited<ReturnType<typeof snapshotPinExport.apply>>

type FakeSources = {
    releases: ReturnType<typeof vi.fn<(params: { name: string }) => Promise<string[] | null>>>
    releaseMetadata: ReturnType<typeof vi.fn<(params: { name: string, version: string }) => Promise<unknown>>>
    snapshotMetadata: ReturnType<typeof vi.fn<(params: { name: string, version: string }) => Promise<unknown>>>
} & SnapshotExportSources
