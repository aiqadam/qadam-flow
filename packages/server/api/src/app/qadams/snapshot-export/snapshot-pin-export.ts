import {
    EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES,
    EmbeddedSnapshotMetadata,
    embeddedSnapshotMetadataUtil,
    ExportedUnresolvedStep,
    FlowActionType,
    flowQadamUtil,
    flowStructureUtil,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    isNil,
    ParsedQadamVersion,
    qadamVersionParser,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import semVer from 'semver'
import { qadamPropsCompatibility, StepTarget } from './qadam-props-compatibility'
import { SnapshotExportSources } from './snapshot-export-sources'

// ADR-0004 "Export and import". What a flow looks like when it leaves the instance:
//
// - `rewrite` (the default): a snapshot pin becomes the newest release at or above its base, inside
//   its caret range, that passes the props check against the snapshot's own `metadata.json`; if none
//   does, it becomes `^<base>` and the step is listed as exported-unresolved. The importer marks each
//   listed step "update this step", and the export hands the list to the person exporting.
// - `keep` (the explicit opt-in): the pins stay as they are and each kept snapshot's `metadata.json`
//   travels with the flow, so the importing instance can run the same check.
// - `same-instance`: nothing changes; a template that stays here keeps the code its flow was built on.
//
// Only the exported copy changes; the flow on this instance keeps its pins.
export const snapshotPinExport = {
    // The query's two flags; a caller that says neither is an export that leaves the instance.
    modeFor: ({ sameInstance, keepSnapshots }: { sameInstance?: boolean, keepSnapshots?: boolean }): SnapshotExportMode => {
        if (sameInstance === true) {
            return SnapshotExportMode.SAME_INSTANCE
        }
        return keepSnapshots === true ? SnapshotExportMode.KEEP : SnapshotExportMode.REWRITE
    },

    apply: async ({ flowVersion, mode, sources, log }: ApplyParams): Promise<FlowVersion & ExportedFields> => {
        switch (mode) {
            case SnapshotExportMode.SAME_INSTANCE:
                return flowVersion
            case SnapshotExportMode.KEEP: {
                const snapshotMetadata = await embedMetadata({ trigger: flowVersion.trigger, sources, log })
                return isNil(snapshotMetadata) ? flowVersion : { ...flowVersion, snapshotMetadata }
            }
            case SnapshotExportMode.REWRITE: {
                const { trigger, unresolved } = await rewritePins({ trigger: flowVersion.trigger, sources })
                return unresolved.length === 0 ? { ...flowVersion, trigger } : { ...flowVersion, trigger, exportedUnresolved: unresolved }
            }
        }
    },
}

export enum SnapshotExportMode {
    REWRITE = 'rewrite',
    KEEP = 'keep',
    SAME_INSTANCE = 'same-instance',
}

// Bounds the outbound fetches one pin can cost: the newest releases are the ones worth trying.
const MAX_RELEASES_CHECKED_PER_PIN = 25

async function rewritePins({ trigger, sources }: { trigger: FlowTrigger, sources: SnapshotExportSources }): Promise<RewriteResult> {
    const rewritten: FlowTrigger = JSON.parse(JSON.stringify(trigger))
    const resolutions = new Map<string, Promise<string | null>>()
    const unresolved: ExportedUnresolvedStep[] = []
    for (const step of flowStructureUtil.getAllSteps(rewritten)) {
        if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
            continue
        }
        const pin = qadamVersionParser.parsePin({ pin: step.settings.qadamVersion })
        if (isNil(pin) || pin.version.snapshot === null) {
            continue
        }
        const original = step.settings.qadamVersion
        const target = step.type === FlowTriggerType.PIECE
            ? toTarget({ kind: 'trigger', name: step.settings.triggerName })
            : toTarget({ kind: 'action', name: step.settings.actionName })
        const key = JSON.stringify([step.settings.qadamName, original, target])
        const resolution = resolutions.get(key) ?? newestPassingRelease({ name: step.settings.qadamName, snapshot: pin.version, target, sources })
        resolutions.set(key, resolution)
        const release = await resolution
        if (isNil(release)) {
            step.settings.qadamVersion = `^${baseOf({ version: pin.version })}`
            unresolved.push({ stepName: step.name, qadamName: step.settings.qadamName, pin: original })
        }
        else {
            step.settings.qadamVersion = `${pin.range ?? ''}${release}`
        }
    }
    return { trigger: rewritten, unresolved }
}

async function newestPassingRelease({ name, snapshot, target, sources }: { name: string, snapshot: ParsedQadamVersion, target: StepTarget | null, sources: SnapshotExportSources }): Promise<string | null> {
    if (isNil(target)) {
        return null
    }
    const base = baseOf({ version: snapshot })
    const snapshotMetadata = await sources.snapshotMetadata({ name, version: `${base}-main.${snapshot.snapshot}` })
    if (isNil(snapshotMetadata)) {
        return null
    }
    const candidates = (await sources.releases({ name }))
        .filter((version) => qadamVersionParser.isRelease({ version }) && semVer.satisfies(version, `^${base}`))
        .sort(semVer.rcompare)
        .slice(0, MAX_RELEASES_CHECKED_PER_PIN)
    for (const candidate of candidates) {
        const releaseMetadata = await sources.releaseMetadata({ name, version: candidate })
        if (!isNil(releaseMetadata) && qadamPropsCompatibility.check({ from: snapshotMetadata, to: releaseMetadata, target }).compatible) {
            return candidate
        }
    }
    return null
}

async function embedMetadata({ trigger, sources, log }: { trigger: FlowTrigger, sources: SnapshotExportSources, log: FastifyBaseLogger }): Promise<Record<string, EmbeddedSnapshotMetadata> | null> {
    const coordinates = new Map<string, { name: string, version: string }>()
    for (const step of flowStructureUtil.getAllSteps(trigger)) {
        if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
            continue
        }
        const version = flowQadamUtil.getExactVersion(step.settings.qadamVersion)
        if (qadamVersionParser.isSnapshot({ version })) {
            coordinates.set(embeddedSnapshotMetadataUtil.key({ name: step.settings.qadamName, version }), { name: step.settings.qadamName, version })
        }
    }
    const embedded: Record<string, EmbeddedSnapshotMetadata> = {}
    for (const [key, snapshot] of [...coordinates].slice(0, EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES)) {
        const parsed = EmbeddedSnapshotMetadata.safeParse(await sources.snapshotMetadata(snapshot))
        if (parsed.success && key === embeddedSnapshotMetadataUtil.key(parsed.data)) {
            embedded[key] = parsed.data
        }
        else {
            log.warn({ qadam: snapshot.name, version: snapshot.version }, '[snapshotExport] No usable metadata.json for a snapshot pin kept in an export; the importing instance will mark the step')
        }
    }
    return Object.keys(embedded).length === 0 ? null : embedded
}

function toTarget({ kind, name }: { kind: StepTarget['kind'], name: string | undefined }): StepTarget | null {
    return isNil(name) ? null : { kind, name }
}

function baseOf({ version }: { version: ParsedQadamVersion }): string {
    return `${version.major}.${version.minor}.${version.patch}`
}

type ApplyParams = {
    flowVersion: FlowVersion
    mode: SnapshotExportMode
    sources: SnapshotExportSources
    log: FastifyBaseLogger
}

type ExportedFields = {
    exportedUnresolved?: ExportedUnresolvedStep[]
    snapshotMetadata?: Record<string, EmbeddedSnapshotMetadata>
}

type RewriteResult = {
    trigger: FlowTrigger
    unresolved: ExportedUnresolvedStep[]
}
