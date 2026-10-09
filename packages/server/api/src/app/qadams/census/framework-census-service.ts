import { FrameworkContextVersion } from '@aiqadam/qadams-framework'
import {
    chunk,
    FlowActionType,
    FlowStatus,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    isNil,
    isObject,
    isOfficialQadamName,
    QadamType,
    tryCatch,
    tryCatchSync,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import semver from 'semver'
import { IsNull, QueryFailedError } from 'typeorm'
import { flowRepo } from '../../flows/flow/flow.repo'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { platformRepo } from '../../platform/platform.service'
import { QadamMetadataSchema } from '../metadata/qadam-metadata-entity'
import { qadamMetadataService, qadamRepos } from '../metadata/qadam-metadata-service'
import { qadamPinUtil } from '../metadata/qadam-pin-util'
import { loadBundledQadams } from '../metadata/utils'
import { frameworkBuildMajor } from './framework-build-major'
import { frameworkCensusPolicy, FrameworkCensusStatus } from './framework-census-policy'

const FLOW_BATCH_SIZE = 100
// Distinct pins resolved concurrently: each one can cost a `qadam_metadata` read, and a platform
// can pin hundreds, so they go in bounded batches rather than one unbounded `Promise.all`.
const PIN_BATCH_SIZE = 20
// Postgres `undefined_column`.
const POSTGRES_UNDEFINED_COLUMN = '42703'

// The framework-major census of ADR-0002: stored flow versions → pinned `name@version` → the
// context version that qadam version needs → whether this release still runs it. It never writes,
// and it reads only the columns it needs through raw rows (never `flowVersionMigrationService`,
// which writes): the `doctor` runs it from a new image, through a connection that neither migrates
// nor writes (`openReadOnlyDatabaseConnection`), against a database that may predate columns this
// release's entities declare. A column that does not exist yet reads as unknown; any other read
// failure is an error, never a step reported as unsupported.
export const frameworkCensusService = (log: FastifyBaseLogger) => ({
    // Distinct pins only, each resolved once: a flow with twelve steps on one pin costs one lookup.
    async resolvePins({ pins, platformId }: { pins: string[], platformId: string }): Promise<Map<string, PinFrameworkSupport>> {
        const bundled = await loadBundledQadams(log)
        const entries: [string, PinFrameworkSupport][] = []
        for (const batch of chunk([...new Set(pins)], PIN_BATCH_SIZE)) {
            entries.push(...await Promise.all(batch.map(async (pin): Promise<[string, PinFrameworkSupport]> => {
                const context = await resolvePinContext({ pin, platformId, bundled, log })
                return [pin, { ...context, status: frameworkCensusPolicy.statusOf({ contextVersion: context.contextVersion }) }]
            })))
        }
        return new Map(entries)
    },

    // Every flow of one platform: its published version (what runs) and its latest version (what
    // the builder edits and test runs use), each step counted once per version. It walks the
    // platform one flow batch at a time and counts statuses as it goes, so memory holds one batch,
    // the distinct pins and the steps it keeps — all `legacy` and `unsupported` ones, or with
    // `maxSteps` at most that many, `unsupported` first.
    async censusOfPlatform({ platformId, maxSteps }: { platformId: string, maxSteps?: number }): Promise<PlatformFrameworkCensus> {
        const supportByPin = new Map<string, PinFrameworkSupport>()
        const unsupportedSteps: FrameworkCensusStep[] = []
        const legacySteps: FrameworkCensusStep[] = []
        let summary = EMPTY_SUMMARY
        let unreadableVersions = 0
        let cursor = ''
        for (;;) {
            const flows = await readFlows({ platformId, cursor })
            if (flows.length === 0) {
                break
            }
            const batch = await readBatch({ platformId, flows, log })
            const newPins = [...new Set(batch.steps.map((step) => step.pin))].filter((pin) => !supportByPin.has(pin))
            const resolved = await frameworkCensusService(log).resolvePins({ pins: newPins, platformId })
            resolved.forEach((support, pin) => supportByPin.set(pin, support))
            const steps = batch.steps.flatMap((step): FrameworkCensusStep[] => {
                const support = supportByPin.get(step.pin)
                return isNil(support) ? [] : [{ ...step, ...support }]
            })
            summary = addSummaries({ a: summary, b: summarize({ steps }) })
            unreadableVersions += batch.unreadableVersions
            unsupportedSteps.push(...keep({ steps, status: 'unsupported', room: roomLeft({ kept: unsupportedSteps, maxSteps }) }))
            legacySteps.push(...keep({ steps, status: 'legacy', room: roomLeft({ kept: legacySteps, maxSteps }) }))
            cursor = flows[flows.length - 1].flowId
        }
        return {
            platformId,
            summary,
            unreadableVersions,
            totalSteps: summary.legacy + summary.unsupported,
            steps: [...unsupportedSteps, ...legacySteps].slice(0, maxSteps ?? Number.POSITIVE_INFINITY),
        }
    },

    // The whole instance, platform by platform. Only the `doctor` command uses this; it reads every
    // platform as a system job may (the precedent is `qadamContextVersionBackfill`), not as a
    // request, so `.agents/rules/data-isolation.md`'s per-request filter has no caller to scope by —
    // each platform's own census is scoped.
    async censusOfInstance(): Promise<InstanceFrameworkCensus> {
        const platforms = await platformRepo().find({
            select: { id: true, name: true },
            order: { created: 'ASC' },
        })
        const censuses: InstanceFrameworkCensus['platforms'] = []
        for (const platform of platforms) {
            const census = await frameworkCensusService(log).censusOfPlatform({ platformId: platform.id })
            censuses.push({ ...census, platformName: platform.name })
        }
        return {
            engine: {
                frameworkMajor: frameworkCensusPolicy.currentFrameworkMajor(),
                contextVersions: [...frameworkCensusPolicy.engineContextVersions()],
            },
            // Flows belong to one platform each, so per-platform counts add up without overlap.
            summary: censuses.reduce((total, census) => addSummaries({ a: total, b: census.summary }), EMPTY_SUMMARY),
            unreadableVersions: censuses.reduce((total, census) => total + census.unreadableVersions, 0),
            platforms: censuses,
        }
    },
})

// Keyset pagination on the flow id, scoped to the platform through the project.
async function readFlows({ platformId, cursor }: { platformId: string, cursor: string }): Promise<CensusFlowRow[]> {
    return flowRepo()
        .createQueryBuilder('flow')
        .innerJoin('project', 'project', 'project.id = flow."projectId"')
        .select('flow.id', 'flowId')
        .addSelect('flow."projectId"', 'projectId')
        .addSelect('flow.status', 'flowStatus')
        .addSelect('flow."publishedVersionId"', 'publishedVersionId')
        .addSelect('project."displayName"', 'projectDisplayName')
        .where('project."platformId" = :platformId', { platformId })
        .andWhere('project.deleted IS NULL')
        .andWhere('flow.id > :cursor', { cursor })
        .orderBy('flow.id', 'ASC')
        .limit(FLOW_BATCH_SIZE)
        .getRawMany<CensusFlowRow>()
}

async function readBatch({ platformId, flows, log }: { platformId: string, flows: CensusFlowRow[], log: FastifyBaseLogger }): Promise<CensusBatch> {
    const flowIds = flows.map((flow) => flow.flowId)
    const publishedIds = flows.map((flow) => flow.publishedVersionId).filter((id): id is string => !isNil(id))
    const [latestVersions, publishedVersions] = await Promise.all([
        versionsQuery({ platformId })
            .andWhere('fv."flowId" IN (:...flowIds)', { flowIds })
            .distinctOn(['fv."flowId"'])
            .orderBy('fv."flowId"')
            .addOrderBy('fv.created', 'DESC')
            .getMany(),
        publishedIds.length === 0
            ? Promise.resolve([])
            : versionsQuery({ platformId }).andWhere('fv.id IN (:...publishedIds)', { publishedIds }).getMany(),
    ])
    const flowById = new Map(flows.map((flow) => [flow.flowId, flow]))
    const versionById = new Map([...publishedVersions, ...latestVersions].map((version) => [version.id, version]))
    const versions = [...versionById.values()]
    const readings = versions.map((version) => {
        const flow = flowById.get(version.flowId)
        if (isNil(flow)) {
            return { steps: [], unreadable: false }
        }
        const { data: steps, error } = tryCatchSync(() => pinnedStepsOf({ version, flow }))
        if (error !== null) {
            log.warn({ flowId: flow.flowId, flowVersionId: version.id }, '[frameworkCensus] Flow version could not be read; skipped')
            return { steps: [], unreadable: true }
        }
        return { steps, unreadable: false }
    })
    return {
        steps: readings.flatMap((reading) => reading.steps),
        unreadableVersions: readings.filter((reading) => reading.unreadable).length,
    }
}

function versionsQuery({ platformId }: { platformId: string }) {
    return flowVersionRepo()
        .createQueryBuilder('fv')
        .innerJoin('flow', 'flow', 'flow.id = fv."flowId"')
        .innerJoin('project', 'project', 'project.id = flow."projectId"')
        .select(['fv.id', 'fv.flowId', 'fv.displayName', 'fv.trigger', 'fv.created'])
        .where('project."platformId" = :platformId', { platformId })
}

// Raw rows, so a version stored before `migrate-v22-rename-piece-to-qadam` still carries
// `pieceName` / `pieceVersion`; reading both keeps such a version in the count instead of
// silently dropping its steps.
function pinnedStepsOf({ version, flow }: { version: CensusVersionRow, flow: CensusFlowRow }): CensusStepOccurrence[] {
    return flowStructureUtil.getAllSteps(version.trigger).flatMap((step): CensusStepOccurrence[] => {
        if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
            return []
        }
        const settings: unknown = step.settings
        const qadamName = readString({ value: settings, keys: ['qadamName', 'pieceName'] })
        const qadamVersion = readString({ value: settings, keys: ['qadamVersion', 'pieceVersion'] })
        if (isNil(qadamName) || isNil(qadamVersion)) {
            return []
        }
        return [{
            projectId: flow.projectId,
            projectDisplayName: flow.projectDisplayName,
            flowId: flow.flowId,
            flowDisplayName: version.displayName,
            flowStatus: flow.flowStatus,
            flowVersionId: version.id,
            version: version.id === flow.publishedVersionId ? 'published' : 'draft',
            stepName: step.name,
            stepDisplayName: step.displayName,
            pin: `${qadamName}@${qadamVersion}`,
        }]
    })
}

function readString({ value, keys }: { value: unknown, keys: string[] }): string | undefined {
    if (!isObject(value)) {
        return undefined
    }
    const found = keys.map((key) => value[key]).find((candidate) => typeof candidate === 'string' && candidate.length > 0)
    return typeof found === 'string' ? found : undefined
}

async function resolvePinContext({ pin, platformId, bundled, log }: ResolvePinContextParams): Promise<PinContext> {
    const { name, version } = qadamPinUtil.splitPin({ pin })
    // A bundled name shadows a persisted row of the same name (`qadam-cache.ts`), and #503 keeps
    // custom rows out of the official scope, so either one means the official path.
    const isOfficial = isOfficialQadamName(name) || bundled.some((qadam) => qadam.name === name)
    return isOfficial
        ? resolveOfficialPin({ name, version, platformId, bundled, log })
        : resolveCustomPin({ name, version, platformId, log })
}

// The version that runs is what `qadamMetadataService.get` resolves the pin to (exact, else the
// bundled build inside the pin's caret range). A bundled build's framework major comes from its
// own `package.json`; a persisted official row (the registry install path) carries its context
// version itself.
async function resolveOfficialPin({ name, version, platformId, bundled, log }: ResolveOfficialPinParams): Promise<PinContext> {
    const resolvedVersion = await resolvePinVersion({ name, version, platformId, log })
    if (isNil(resolvedVersion)) {
        return UNRESOLVED
    }
    const build = bundled.find((qadam) => qadam.name === name && qadam.version === resolvedVersion)
    if (!isNil(build)) {
        const frameworkMajor = await frameworkBuildMajor.ofBuild({ directoryPath: build.directoryPath })
        return {
            source: 'official',
            frameworkMajor,
            contextVersion: isNil(frameworkMajor) ? null : frameworkCensusPolicy.contextOfOfficialMajor({ major: frameworkMajor }),
        }
    }
    // A version answered the pin, so it is not `unresolved` even when no official row records its
    // context version (a registry entry this path does not read, or — until #779 extends this —
    // the local store): its context version is unknown, which counts as still needing the old
    // contract, and the MCP marking still marks it. `unresolved` is reserved for a pin nothing
    // answers, which the `qadam_version` signal already reports.
    const contextVersion = await readStoredContextVersion({ name, version: resolvedVersion, platformId: null, qadamType: QadamType.OFFICIAL })
    return { source: 'official', frameworkMajor: null, contextVersion }
}

// A custom step runs the version `qadamMetadataService.get` resolves the pin to — exact when the
// pin is exact, the highest match inside a `~`/`^` range otherwise (the MCP tools pin `~`, the
// builder pins exact) — and that row's `contextVersion` is the answer (ADR-0002). A pin nothing
// resolves counts as unknown, and unknown counts as still needing the old contract.
async function resolveCustomPin({ name, version, platformId, log }: ResolveCustomPinParams): Promise<PinContext> {
    const resolvedVersion = await resolvePinVersion({ name, version, platformId, log })
    if (isNil(resolvedVersion)) {
        return UNRESOLVED
    }
    // As on the official path, a version answered the pin: no custom row for it (the registry
    // matched a row of another type) is an unknown context version, not an unresolved pin.
    const contextVersion = await readStoredContextVersion({ name, version: resolvedVersion, platformId, qadamType: QadamType.CUSTOM })
    return { source: 'custom', frameworkMajor: null, contextVersion }
}

// What `qadamMetadataService.get` resolves the pin to, through the registry's named columns only, so
// it answers on a database that predates columns this release adds to `qadam_metadata`. A version
// string no resolver can read is a pin that does not resolve; a failed read is an error, not a miss.
async function resolvePinVersion({ name, version, platformId, log }: ResolvePinVersionParams): Promise<string | undefined> {
    if (isNil(semver.valid(version.replace(/^[\^~]/, '')))) {
        return undefined
    }
    return qadamMetadataService(log).resolveVersion({ name, version, platformId })
}

// Only the column the census needs: a database the doctor reads before an upgrade may predate
// other `qadam_metadata` columns this release's entity declares. A database that predates
// `contextVersion` itself (#802) reads as unknown. Any other failure — a timeout, a dropped
// connection — is thrown: reading it as unknown would report a healthy step as one that stops
// running.
async function readStoredContextVersion({ name, version, platformId, qadamType }: ReadStoredContextVersionParams): Promise<FrameworkContextVersion | null> {
    const { data: row, error } = await tryCatch(() => qadamRepos().findOne({
        select: { id: true, contextVersion: true },
        where: { name, version, platformId: platformId ?? IsNull(), qadamType },
    }))
    if (error !== null) {
        if (isUndefinedColumn(error)) {
            return null
        }
        throw error
    }
    return isNil(row) ? null : frameworkCensusPolicy.fromStoredContextVersion({ value: row.contextVersion })
}

function isUndefinedColumn(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
        return false
    }
    const driverError: unknown = error.driverError
    return typeof driverError === 'object'
        && driverError !== null
        && 'code' in driverError
        && driverError.code === POSTGRES_UNDEFINED_COLUMN
}

// A batch holds whole flows (both of a flow's versions are read with it), so a flow's unsupported
// steps are all in one batch and `flowsWithUnsupportedSteps` adds up across batches.
function summarize({ steps }: { steps: { status: FrameworkCensusStatus, flowId: string }[] }): FrameworkCensusSummary {
    return {
        current: steps.filter((step) => step.status === 'current').length,
        legacy: steps.filter((step) => step.status === 'legacy').length,
        unsupported: steps.filter((step) => step.status === 'unsupported').length,
        flowsWithUnsupportedSteps: new Set(steps.filter((step) => step.status === 'unsupported').map((step) => step.flowId)).size,
    }
}

function addSummaries({ a, b }: { a: FrameworkCensusSummary, b: FrameworkCensusSummary }): FrameworkCensusSummary {
    return {
        current: a.current + b.current,
        legacy: a.legacy + b.legacy,
        unsupported: a.unsupported + b.unsupported,
        flowsWithUnsupportedSteps: a.flowsWithUnsupportedSteps + b.flowsWithUnsupportedSteps,
    }
}

function roomLeft({ kept, maxSteps }: { kept: FrameworkCensusStep[], maxSteps: number | undefined }): number {
    return isNil(maxSteps) ? Number.POSITIVE_INFINITY : Math.max(0, maxSteps - kept.length)
}

function keep({ steps, status, room }: { steps: FrameworkCensusStep[], status: FrameworkCensusStatus, room: number }): FrameworkCensusStep[] {
    return steps.filter((step) => step.status === status).slice(0, room)
}

const EMPTY_SUMMARY: FrameworkCensusSummary = { current: 0, legacy: 0, unsupported: 0, flowsWithUnsupportedSteps: 0 }

const UNRESOLVED: PinContext = { source: 'unresolved', frameworkMajor: null, contextVersion: null }

// `unresolved`: no qadam version on this instance answers the pin, so its context version is
// unknown and it counts as still needing the old contract (ADR-0002).
export type PinContext = {
    source: 'official' | 'custom' | 'unresolved'
    // Known only for a bundled official build; `null` elsewhere.
    frameworkMajor: number | null
    // `null` is unknown.
    contextVersion: FrameworkContextVersion | null
}

export type PinFrameworkSupport = PinContext & {
    status: FrameworkCensusStatus
}

export type FrameworkCensusStep = CensusStepOccurrence & PinFrameworkSupport

export type FrameworkCensusSummary = {
    // Step occurrences: a step present in both the published and the latest version counts twice.
    current: number
    legacy: number
    unsupported: number
    flowsWithUnsupportedSteps: number
}

export type PlatformFrameworkCensus = {
    platformId: string
    summary: FrameworkCensusSummary
    // Flow versions whose step tree could not be walked; their steps are not in the counts.
    unreadableVersions: number
    // How many `legacy` and `unsupported` step occurrences the census found; `steps` may carry
    // fewer when the caller capped it.
    totalSteps: number
    // `legacy` and `unsupported` steps only, `unsupported` first; `current` ones are counted in the
    // summary.
    steps: FrameworkCensusStep[]
}

export type InstanceFrameworkCensus = {
    engine: {
        frameworkMajor: number
        contextVersions: FrameworkContextVersion[]
    }
    summary: FrameworkCensusSummary
    // Flow versions, across every platform, whose step tree could not be walked. Their steps are in
    // no count, so a step among them may stop running on this release (ADR-0002: unknown counts as
    // still needing the old contract).
    unreadableVersions: number
    platforms: (PlatformFrameworkCensus & { platformName: string })[]
}

type CensusStepOccurrence = {
    projectId: string
    projectDisplayName: string
    flowId: string
    flowDisplayName: string
    flowStatus: FlowStatus
    flowVersionId: string
    version: 'published' | 'draft'
    stepName: string
    stepDisplayName: string
    pin: string
}

type CensusFlowRow = {
    flowId: string
    projectId: string
    flowStatus: FlowStatus
    publishedVersionId: string | null
    projectDisplayName: string
}

type CensusVersionRow = Pick<FlowVersion, 'id' | 'flowId' | 'displayName' | 'trigger'>

type CensusBatch = {
    steps: CensusStepOccurrence[]
    unreadableVersions: number
}

type ResolvePinContextParams = {
    pin: string
    platformId: string
    bundled: QadamMetadataSchema[]
    log: FastifyBaseLogger
}

type ResolveOfficialPinParams = {
    name: string
    version: string
    platformId: string
    bundled: QadamMetadataSchema[]
    log: FastifyBaseLogger
}

type ReadStoredContextVersionParams = {
    name: string
    version: string
    platformId: string | null
    qadamType: QadamType
}

type ResolvePinVersionParams = {
    name: string
    version: string
    platformId: string
    log: FastifyBaseLogger
}

type ResolveCustomPinParams = {
    name: string
    version: string
    platformId: string
    log: FastifyBaseLogger
}
