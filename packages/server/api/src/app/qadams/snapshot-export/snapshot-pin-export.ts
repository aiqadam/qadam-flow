import {
    AgentQadamProps,
    AgentQadamTool,
    EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES,
    EmbeddedSnapshotMetadata,
    embeddedSnapshotMetadataUtil,
    ExportedUnresolvedReason,
    ExportedUnresolvedStep,
    FlowActionType,
    flowStructureUtil,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    isNil,
    ParsedQadamPin,
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
// A pin is a qadam step's `qadamVersion` or the `qadamMetadata.qadamVersion` of an agent tool of a
// step (an agent tool names its action, so it is checked like a step). Only the exported copy
// changes; the flow on this instance keeps its pins, and a marker a file once brought is dropped.
export const snapshotPinExport = {
    // The query's two flags; a caller that says neither is an export that leaves the instance.
    modeFor: ({ sameInstance, keepSnapshots }: { sameInstance?: boolean, keepSnapshots?: boolean }): SnapshotExportMode => {
        if (sameInstance === true) {
            return SnapshotExportMode.SAME_INSTANCE
        }
        return keepSnapshots === true ? SnapshotExportMode.KEEP : SnapshotExportMode.REWRITE
    },

    apply: async ({ flowVersion, mode, sources, log }: ApplyParams): Promise<FlowVersion & ExportedFields> => {
        if (mode === SnapshotExportMode.SAME_INSTANCE) {
            return flowVersion
        }
        const trigger: FlowTrigger = structuredClone(flowVersion.trigger)
        const sites = collectPinSites({ trigger })
        const session = createSession({ sources, log })
        if (mode === SnapshotExportMode.KEEP) {
            const snapshotMetadata = await embedMetadata({ sites, session, log })
            return isNil(snapshotMetadata) ? { ...flowVersion, trigger } : { ...flowVersion, trigger, snapshotMetadata }
        }
        const unresolved = await rewritePins({ sites, session })
        if (session.state.exhausted) {
            log.warn({ budget: MAX_RELEASE_FETCHES_PER_EXPORT }, '[snapshotExport] The fetch or read budget of this export ran out; the remaining snapshot pins are exported as unresolved')
        }
        return unresolved.length === 0 ? { ...flowVersion, trigger } : { ...flowVersion, trigger, exportedUnresolved: unresolved }
    },
}

export enum SnapshotExportMode {
    REWRITE = 'rewrite',
    KEEP = 'keep',
    SAME_INSTANCE = 'same-instance',
}

// Bound what one pin, and one whole export, can cost in outbound fetches: the newest releases are the
// ones worth trying, and a flow cannot make a single request fetch without limit.
export const MAX_RELEASES_CHECKED_PER_PIN = 25
export const MAX_RELEASE_FETCHES_PER_EXPORT = 50
export const MAX_SNAPSHOT_READS_PER_EXPORT = 64

async function rewritePins({ sites, session }: { sites: PinSite[], session: Session }): Promise<ExportedUnresolvedStep[]> {
    const snapshotSites = sites.filter((site) => isSnapshot({ pin: site.pin }))
    // Pins resolve together, so which of them the fetch budget reaches first is not fixed; every
    // pin it does not reach is listed, never moved.
    const resolutions = await Promise.all(snapshotSites.map((site) => resolve({ site, session })))
    const unresolved: ExportedUnresolvedStep[] = []
    for (const [index, site] of snapshotSites.entries()) {
        const resolution = resolutions[index]
        if (resolution.release === null) {
            site.write({ version: `${site.pin.range ?? '^'}${baseOf({ pin: site.pin })}` })
            unresolved.push({ stepName: site.stepName, qadamName: site.qadamName, pin: site.original, reason: resolution.reason })
        }
        else {
            site.write({ version: `${site.pin.range ?? ''}${resolution.release}` })
        }
    }
    return unresolved
}

// One resolution per distinct pin and action: steps that share them share the answer, and the
// fetches under it are shared by every action of the same snapshot.
function resolve({ site, session }: { site: PinSite, session: Session }): Promise<Resolution> {
    const key = JSON.stringify([site.qadamName, site.original, site.target])
    const cached = session.resolutions.get(key)
    if (!isNil(cached)) {
        return cached
    }
    const resolution = newestPassingRelease({ site, session })
    session.resolutions.set(key, resolution)
    return resolution
}

async function newestPassingRelease({ site, session }: { site: PinSite, session: Session }): Promise<Resolution> {
    const { target } = site
    if (isNil(target)) {
        return unresolvedBecause('not-describable')
    }
    const snapshotMetadata = await session.snapshotMetadata({ name: site.qadamName, version: snapshotVersionOf({ pin: site.pin }) })
    if (isNil(snapshotMetadata)) {
        return unresolvedBecause('metadata-unavailable')
    }
    // Before any release is listed or fetched: a step that names an action the snapshot does not
    // have costs no fetch, and the parsed metadata is shared, so it costs a lookup.
    if (!qadamPropsCompatibility.describes({ metadata: snapshotMetadata, target })) {
        return unresolvedBecause('not-describable')
    }
    const base = baseOf({ pin: site.pin })
    const released = await session.releases({ name: site.qadamName })
    if (isNil(released)) {
        return unresolvedBecause('catalogue-unavailable')
    }
    // The pin's own range: a `~` pin stays on its minor.
    const range = `${site.pin.range ?? '^'}${base}`
    const candidates = released
        .filter((version) => qadamVersionParser.isRelease({ version }) && semVer.satisfies(version, range))
        .sort(semVer.rcompare)
        .slice(0, MAX_RELEASES_CHECKED_PER_PIN)
    let unreadable = false
    for (const candidate of candidates) {
        const fetched = await session.releaseMetadata({ name: site.qadamName, version: candidate })
        if (fetched.status === 'unavailable') {
            unreadable = true
            continue
        }
        if (qadamPropsCompatibility.check({ from: snapshotMetadata, to: fetched.metadata, target }).compatible) {
            return { release: candidate }
        }
    }
    return unresolvedBecause(unreadable ? 'metadata-unavailable' : 'no-compatible-release')
}

async function embedMetadata({ sites, session, log }: { sites: PinSite[], session: Session, log: FastifyBaseLogger }): Promise<Record<string, EmbeddedSnapshotMetadata> | null> {
    const coordinates = new Map<string, { name: string, version: string }>()
    for (const site of sites) {
        if (isSnapshot({ pin: site.pin })) {
            const version = snapshotVersionOf({ pin: site.pin })
            coordinates.set(embeddedSnapshotMetadataUtil.key({ name: site.qadamName, version }), { name: site.qadamName, version })
        }
    }
    const kept = [...coordinates].slice(0, EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES)
    if (coordinates.size > kept.length) {
        log.warn({ snapshots: coordinates.size, kept: kept.length }, '[snapshotExport] More snapshot pins than an export can embed metadata for; the importing instance will mark the others')
    }
    const embedded: Record<string, EmbeddedSnapshotMetadata> = {}
    for (const [key, snapshot] of kept) {
        const parsed = EmbeddedSnapshotMetadata.safeParse(await session.snapshotMetadata(snapshot))
        if (parsed.success && key === embeddedSnapshotMetadataUtil.key(parsed.data)) {
            embedded[key] = parsed.data
        }
        else {
            log.warn({ qadam: snapshot.name, version: snapshot.version }, '[snapshotExport] No usable metadata.json for a snapshot pin kept in an export; the importing instance will mark the step')
        }
    }
    return Object.keys(embedded).length === 0 ? null : embedded
}

// Every pin of the flow, steps and agent tools, in flow order, with how to rewrite it in place. The
// trigger is the caller's clone, so writing through a site never reaches the stored flow. Also where
// a marker the file brought is dropped: only an importer writes one.
function collectPinSites({ trigger }: { trigger: FlowTrigger }): PinSite[] {
    const sites: PinSite[] = []
    for (const step of flowStructureUtil.getAllSteps(trigger)) {
        if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
            continue
        }
        delete step.settings.exportedUnresolvedPin
        const pin = qadamVersionParser.parsePin({ pin: step.settings.qadamVersion })
        const target = step.type === FlowTriggerType.PIECE
            ? toTarget({ kind: 'trigger', name: step.settings.triggerName })
            : toTarget({ kind: 'action', name: step.settings.actionName })
        if (!isNil(pin)) {
            sites.push({
                stepName: step.name,
                qadamName: step.settings.qadamName,
                original: step.settings.qadamVersion,
                pin,
                target,
                write: ({ version }) => {
                    step.settings.qadamVersion = version
                },
            })
        }
        if (step.type === FlowActionType.PIECE) {
            sites.push(...collectToolSites({ stepName: step.name, input: step.settings.input }))
        }
    }
    return sites
}

// Read like the worker reads a step's tools (`AgentQadamTool`); #878 adds a shared reader for the
// same list, which replaces this one.
function collectToolSites({ stepName, input }: { stepName: string, input: Record<string, unknown> }): PinSite[] {
    const tools = input[AgentQadamProps.AGENT_TOOLS]
    if (!Array.isArray(tools)) {
        return []
    }
    return tools.flatMap((raw, index): PinSite[] => {
        const parsed = AgentQadamTool.safeParse(raw)
        const pin = parsed.success ? qadamVersionParser.parsePin({ pin: parsed.data.qadamMetadata.qadamVersion }) : null
        if (!parsed.success || isNil(pin) || !isRecord(raw)) {
            return []
        }
        const { qadamName, qadamVersion, actionName } = parsed.data.qadamMetadata
        return [{
            stepName,
            qadamName,
            original: qadamVersion,
            pin,
            target: { kind: 'action', name: actionName },
            write: ({ version }): void => {
                tools[index] = { ...raw, qadamMetadata: { ...(isRecord(raw['qadamMetadata']) ? raw['qadamMetadata'] : parsed.data.qadamMetadata), qadamVersion: version } }
            },
        }]
    })
}

// Everything one export fetches is remembered for that export: a release's metadata is read once
// however many pins or actions ask for it, and the budget counts the reads that went out.
function createSession({ sources, log }: { sources: SnapshotExportSources, log: FastifyBaseLogger }): Session {
    const state = { remaining: MAX_RELEASE_FETCHES_PER_EXPORT, exhausted: false }
    const snapshots = new Map<string, Promise<unknown>>()
    const releases = new Map<string, Promise<string[] | null>>()
    const releaseMetadata = new Map<string, Promise<ReleaseMetadataResult>>()
    return {
        state,
        resolutions: new Map(),
        snapshotMetadata: (params) => memoise({
            cache: snapshots,
            key: embeddedSnapshotMetadataUtil.key(params),
            load: async () => {
                if (snapshots.size >= MAX_SNAPSHOT_READS_PER_EXPORT) {
                    state.exhausted = true
                    return null
                }
                return sources.snapshotMetadata(params)
            },
        }),
        releases: (params) => memoise({ cache: releases, key: params.name, load: () => sources.releases(params) }),
        releaseMetadata: (params) => memoise({
            cache: releaseMetadata,
            key: embeddedSnapshotMetadataUtil.key(params),
            load: async () => {
                if (state.remaining <= 0) {
                    state.exhausted = true
                    return { status: 'unavailable' }
                }
                state.remaining -= 1
                const metadata = await sources.releaseMetadata(params)
                if (isNil(metadata)) {
                    log.debug({ qadam: params.name, version: params.version }, '[snapshotExport] No metadata for a release')
                    return { status: 'unavailable' }
                }
                return { status: 'ok', metadata }
            },
        }),
    }
}

function memoise<T>({ cache, key, load }: { cache: Map<string, Promise<T>>, key: string, load: () => Promise<T> }): Promise<T> {
    const cached = cache.get(key)
    if (!isNil(cached)) {
        return cached
    }
    const loading = load()
    cache.set(key, loading)
    return loading
}

function unresolvedBecause(reason: ExportedUnresolvedReason): Resolution {
    return { release: null, reason }
}

function toTarget({ kind, name }: { kind: StepTarget['kind'], name: string | undefined }): StepTarget | null {
    return isNil(name) ? null : { kind, name }
}

function isSnapshot({ pin }: { pin: ParsedQadamPin }): boolean {
    return pin.version.snapshot !== null
}

function baseOf({ pin }: { pin: ParsedQadamPin }): string {
    return `${pin.version.major}.${pin.version.minor}.${pin.version.patch}`
}

function snapshotVersionOf({ pin }: { pin: ParsedQadamPin }): string {
    return `${baseOf({ pin })}-main.${pin.version.snapshot}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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

type PinSite = {
    stepName: string
    qadamName: string
    // The pin as the flow wrote it, with its `^` or `~`.
    original: string
    pin: ParsedQadamPin
    target: StepTarget | null
    write: (params: { version: string }) => void
}

type Resolution =
    | { release: string }
    | { release: null, reason: ExportedUnresolvedReason }

type ReleaseMetadataResult =
    | { status: 'ok', metadata: unknown }
    | { status: 'unavailable' }

type Session = {
    state: { remaining: number, exhausted: boolean }
    resolutions: Map<string, Promise<Resolution>>
    snapshotMetadata: (params: { name: string, version: string }) => Promise<unknown>
    releases: (params: { name: string }) => Promise<string[] | null>
    releaseMetadata: (params: { name: string, version: string }) => Promise<ReleaseMetadataResult>
}
