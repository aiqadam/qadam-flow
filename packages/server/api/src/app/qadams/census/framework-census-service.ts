import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { FrameworkContextVersion } from '@aiqadam/qadams-framework'
import {
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
    unique,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import semver from 'semver'
import { IsNull } from 'typeorm'
import { z } from 'zod'
import { flowRepo } from '../../flows/flow/flow.repo'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { platformRepo } from '../../platform/platform.service'
import { QadamMetadataSchema } from '../metadata/qadam-metadata-entity'
import { qadamRepos } from '../metadata/qadam-metadata-service'
import { qadamPinUtil } from '../metadata/qadam-pin-util'
import { loadBundledQadams } from '../metadata/utils'
import { frameworkCensusPolicy, FrameworkCensusStatus } from './framework-census-policy'

const FLOW_BATCH_SIZE = 100
const FRAMEWORK_PACKAGE = '@aiqadam/qadams-framework'

// The framework-major census of ADR-0002: stored flow versions → pinned `name@version` → the
// context version that qadam version needs → whether this release still runs it. Read-only by
// construction: `doctor` runs it from a new image against a database that has not been migrated
// yet, so it reads raw rows (never `flowVersionMigrationService`, which writes) and selects only
// the columns it needs.
export const frameworkCensusService = (log: FastifyBaseLogger) => ({
    // Distinct pins only, each resolved once: a flow with twelve steps on one pin costs one lookup.
    async resolvePins({ pins, platformId }: { pins: string[], platformId: string }): Promise<Map<string, PinFrameworkSupport>> {
        const bundled = await loadBundledQadams(log)
        const entries = await Promise.all(unique(pins).map(async (pin): Promise<[string, PinFrameworkSupport]> => {
            const context = await resolvePinContext({ pin, platformId, bundled, log })
            return [pin, { ...context, status: frameworkCensusPolicy.statusOf({ contextVersion: context.contextVersion }) }]
        }))
        return new Map(entries)
    },

    // Every flow of one platform: its published version (what runs) and its latest version (what
    // the builder edits and test runs use), each step counted once per version.
    async censusOfPlatform({ platformId }: { platformId: string }): Promise<PlatformFrameworkCensus> {
        const batches = await collectBatches({ platformId, log })
        const pins = unique(batches.flatMap((batch) => batch.steps.map((step) => step.pin)))
        const supportByPin = await frameworkCensusService(log).resolvePins({ pins, platformId })
        const steps = batches.flatMap((batch) => batch.steps).flatMap((step): FrameworkCensusStep[] => {
            const support = supportByPin.get(step.pin)
            return isNil(support) ? [] : [{ ...step, ...support }]
        })
        return {
            platformId,
            summary: summarize({ steps }),
            unreadableVersions: batches.reduce((total, batch) => total + batch.unreadableVersions, 0),
            steps: steps.filter((step) => step.status !== 'current'),
        }
    },

    // The whole instance, platform by platform. Only the `doctor` command and the instance-level
    // report use this; it reads every platform as a system job may (the precedent is
    // `qadamContextVersionBackfill`), not as a request, so `.agents/rules/data-isolation.md`'s
    // per-request filter has no caller to scope by — each platform's own census is scoped.
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
            summary: summarize({
                steps: censuses.flatMap((census) => census.steps),
                currentSteps: censuses.reduce((total, census) => total + census.summary.current, 0),
            }),
            platforms: censuses,
        }
    },
})

async function collectBatches({ platformId, log }: { platformId: string, log: FastifyBaseLogger }): Promise<CensusBatch[]> {
    const batches: CensusBatch[] = []
    let cursor = ''
    for (;;) {
        const flows = await readFlows({ platformId, cursor })
        if (flows.length === 0) {
            return batches
        }
        batches.push(await readBatch({ platformId, flows, log }))
        cursor = flows[flows.length - 1].flowId
    }
}

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
    const { data: resolvedVersion, error } = await tryCatch(() => qadamPinUtil.resolvePinVersion({ name, version, platformId, log }))
    if (error !== null || isNil(resolvedVersion)) {
        return UNRESOLVED
    }
    const build = bundled.find((qadam) => qadam.name === name && qadam.version === resolvedVersion)
    if (!isNil(build)) {
        const frameworkMajor = await frameworkMajorOfBuild({ directoryPath: build.directoryPath })
        return {
            source: 'official',
            frameworkMajor,
            contextVersion: isNil(frameworkMajor) ? null : frameworkCensusPolicy.contextOfOfficialMajor({ major: frameworkMajor }),
        }
    }
    const stored = await readStoredContextVersion({ name, version: resolvedVersion, platformId: null, qadamType: QadamType.OFFICIAL })
    return { source: 'official', frameworkMajor: null, contextVersion: stored.contextVersion }
}

// A custom step runs the version `qadamMetadataService.get` resolves the pin to — exact when the
// pin is exact, the highest match inside a `~`/`^` range otherwise (the MCP tools pin `~`, the
// builder pins exact) — and that row's `contextVersion` is the answer (ADR-0002). A pin nothing
// resolves counts as unknown, and unknown counts as still needing the old contract.
async function resolveCustomPin({ name, version, platformId, log }: ResolveCustomPinParams): Promise<PinContext> {
    const { data: resolvedVersion, error } = await tryCatch(() => qadamPinUtil.resolvePinVersion({ name, version, platformId, log }))
    if (error !== null || isNil(resolvedVersion)) {
        return UNRESOLVED
    }
    const stored = await readStoredContextVersion({ name, version: resolvedVersion, platformId, qadamType: QadamType.CUSTOM })
    if (!stored.found) {
        return UNRESOLVED
    }
    return { source: 'custom', frameworkMajor: null, contextVersion: stored.contextVersion }
}

// Only the column the census needs: a database the doctor reads before an upgrade may predate
// other `qadam_metadata` columns this release's entity declares. A failed read (for example a
// database that predates `contextVersion`, #802) is unknown, never an error.
async function readStoredContextVersion({ name, version, platformId, qadamType }: ReadStoredContextVersionParams): Promise<StoredContextVersion> {
    const { data: row, error } = await tryCatch(() => qadamRepos().findOne({
        select: { id: true, contextVersion: true },
        where: { name, version, platformId: platformId ?? IsNull(), qadamType },
    }))
    if (error !== null) {
        return { found: true, contextVersion: null }
    }
    if (isNil(row)) {
        return { found: false, contextVersion: null }
    }
    return { found: true, contextVersion: frameworkCensusPolicy.fromStoredContextVersion({ value: row.contextVersion }) }
}

// Bundled builds are compiled in this tree, so their `dist/package.json` names the framework as
// `workspace:*`, which is the current major. A build layered in from elsewhere names a version.
async function frameworkMajorOfBuild({ directoryPath }: { directoryPath: string | undefined }): Promise<number | null> {
    if (isNil(directoryPath)) {
        return frameworkCensusPolicy.currentFrameworkMajor()
    }
    const cached = frameworkMajorByBuild.get(directoryPath)
    if (!isNil(cached)) {
        return cached
    }
    const { data: content } = await tryCatch(() => readFile(path.join(directoryPath, 'package.json'), 'utf-8'))
    const major = readFrameworkMajor({ content })
    frameworkMajorByBuild.set(directoryPath, major)
    return major
}

function readFrameworkMajor({ content }: { content: string | null }): number | null {
    if (isNil(content)) {
        return null
    }
    const { data: json } = tryCatchSync(() => JSON.parse(content))
    const parsed = buildPackageJson.safeParse(json)
    if (!parsed.success) {
        return null
    }
    const spec = parsed.data.dependencies?.[FRAMEWORK_PACKAGE] ?? parsed.data.peerDependencies?.[FRAMEWORK_PACKAGE]
    if (isNil(spec)) {
        return null
    }
    if (spec.startsWith('workspace:')) {
        return frameworkCensusPolicy.currentFrameworkMajor()
    }
    const { data: minimum } = tryCatchSync(() => semver.minVersion(spec))
    return minimum?.major ?? null
}

function summarize({ steps, currentSteps = 0 }: { steps: { status: FrameworkCensusStatus, flowId: string }[], currentSteps?: number }): FrameworkCensusSummary {
    return {
        current: currentSteps + steps.filter((step) => step.status === 'current').length,
        legacy: steps.filter((step) => step.status === 'legacy').length,
        unsupported: steps.filter((step) => step.status === 'unsupported').length,
        flowsWithUnsupportedSteps: unique(steps.filter((step) => step.status === 'unsupported').map((step) => step.flowId)).length,
    }
}

const frameworkMajorByBuild = new Map<string, number | null>()

const UNRESOLVED: PinContext = { source: 'unresolved', frameworkMajor: null, contextVersion: null }

const buildPackageJson = z.object({
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
})

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
    // `legacy` and `unsupported` steps only; `current` ones are counted in the summary.
    steps: FrameworkCensusStep[]
}

export type InstanceFrameworkCensus = {
    engine: {
        frameworkMajor: number
        contextVersions: FrameworkContextVersion[]
    }
    summary: FrameworkCensusSummary
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

type StoredContextVersion = {
    found: boolean
    contextVersion: FrameworkContextVersion | null
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

type ResolveCustomPinParams = {
    name: string
    version: string
    platformId: string
    log: FastifyBaseLogger
}
