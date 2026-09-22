import {
    apId,
    FlowRun,
    FlowRunDispatchMode,
    FlowRunStatus,
    FlowStatus,
    FlowTriggerType,
    INLINE_SUBFLOW_DEPTH_LIMIT,
    isNil,
    StartInlineFlowRunRequest,
    StartInlineFlowRunResult,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedStore } from '../../database/redis-connections'
import { flowService } from '../../flows/flow/flow.service'
import { flowRunRepo } from '../../flows/flow-run/flow-run-service'
import { flowRunSideEffects } from '../../flows/flow-run/flow-run-side-effects'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { projectService } from '../../project/project-service'
import { redisMetadataKey, RunsMetadataUpsertData } from '../job'

const CALLABLE_FLOW_QADAM_NAME = '@aiqadam/qadam-subflows'
const CALLABLE_FLOW_TRIGGER_NAME = 'callableFlow'

export const inlineFlowRunService = (log: FastifyBaseLogger) => ({
    async start(request: StartInlineFlowRunRequest): Promise<StartInlineFlowRunResult> {
        // Never trust the caller's flowId ownership on its own — the flow must belong to
        // the SAME project as the worker's own current job. This is the exact check
        // that was missing from the earlier (reverted) attempt at this feature.
        const flow = await flowService(log).getOneOrThrow({ id: request.flowId, projectId: request.callerProjectId })
        const flowPlatformId = await projectService(log).getPlatformId(flow.projectId)
        if (flowPlatformId !== request.callerPlatformId) {
            // Defense in depth: a project always belongs to exactly one platform, so
            // this can only fire if `callerPlatformId`/`callerProjectId` themselves
            // ever disagreed — but the child run must never be created under a
            // mismatched platform, so check it explicitly rather than trusting the
            // project scope alone to imply it.
            return { ok: false, error: 'The selected subflow does not belong to the caller\'s platform.' }
        }
        if (flow.status !== FlowStatus.ENABLED) {
            return { ok: false, error: 'The selected subflow is disabled.' }
        }
        const flowVersionId = flow.publishedVersionId
        if (isNil(flowVersionId)) {
            return { ok: false, error: 'The selected subflow has no published version.' }
        }
        const flowVersion = await flowVersionService(log).getOneOrThrow(flowVersionId)
        const trigger = flowVersion.trigger
        const isCallableFlowTrigger = trigger.type === FlowTriggerType.PIECE
            && trigger.settings.qadamName === CALLABLE_FLOW_QADAM_NAME
            && trigger.settings.triggerName === CALLABLE_FLOW_TRIGGER_NAME
        if (!isCallableFlowTrigger) {
            return { ok: false, error: 'The selected flow does not have a "Callable Flow" trigger.' }
        }

        // `parentRunId` is supplied by the engine (the run this call is nested
        // under — see inline-flow-executor.ts) and MUST be re-verified server-side:
        // it must be a real run in the caller's own project, never trusted at face
        // value. Otherwise a compromised engine process could attach a child under a
        // foreign project's run (a data-isolation violation) or dodge the depth
        // guard by naming an unrelated run with a short ancestry chain.
        const parentRun = await findParentRun({ parentRunId: request.parentRunId, projectId: request.callerProjectId, log })
        if (isNil(parentRun)) {
            return { ok: false, error: 'The parent run could not be verified.' }
        }

        const inlineDepth = await computeInlineDepth({ parentRun, parentRunId: request.parentRunId })
        if (inlineDepth > INLINE_SUBFLOW_DEPTH_LIMIT) {
            return { ok: false, error: `Inline subflow nesting exceeded the maximum depth of ${INLINE_SUBFLOW_DEPTH_LIMIT}.` }
        }

        const now = new Date().toISOString()
        const flowRun: FlowRun = {
            id: apId(),
            projectId: flow.projectId,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            environment: request.environment,
            parentRunId: request.parentRunId,
            dispatchMode: FlowRunDispatchMode.enum.INLINE,
            failParentOnFailure: true,
            status: FlowRunStatus.RUNNING,
            // Execution starts synchronously right after this row is created — unlike a
            // queued run, there is no separate dequeue moment to mark as the real start.
            // Without this the run-history duration column (startTime && finishTime) never
            // renders for inline child runs, since finalizeInlineChildRun does set finishTime.
            startTime: now,
            created: now,
            updated: now,
            tags: [],
            steps: {},
        }
        await flowRunRepo().save(flowRun)
        await flowRunSideEffects(log).onStart(flowRun)

        return {
            ok: true,
            flowVersion,
            childRunId: flowRun.id,
            childLogsFileId: apId(),
            inlineDepth,
        }
    },
})

/**
 * A PRODUCTION run's row reaches Postgres through the runs-metadata queue rather than the request
 * that created it (`queueOrCreateInstantly`), so a parent accepted milliseconds ago is legitimately
 * absent from the table while that flush is still pending. Reading the pending metadata hash — which
 * the API writes itself before enqueueing, never the engine — keeps the ownership check server-side
 * while dropping the dependency on flush timing. Without the fallback a burst failed ~46% of its runs
 * on a parent that did exist (#509); TESTING writes the row synchronously, which is why a manual test
 * never reproduced it.
 */
async function findParentRun({ parentRunId, projectId, log }: FindParentRunParams): Promise<ParentRun | null> {
    const persistedParentRun = await flowRunRepo().findOneBy({ id: parentRunId, projectId })
    if (!isNil(persistedParentRun)) {
        return { parentRunId: persistedParentRun.parentRunId, persisted: true }
    }

    const { data: pendingMetadata, error } = await tryCatch(() => distributedStore.hgetJson<RunsMetadataUpsertData>(redisMetadataKey(parentRunId)))
    if (!isNil(error)) {
        // Fail closed: an unverifiable parent must never be accepted on the strength of a Redis blip.
        log.warn({ parentRunId, projectId, err: error }, '[inlineFlowRunService#findParentRun] Failed to read pending run metadata, treating parent as unverified')
        return null
    }
    if (isNil(pendingMetadata) || pendingMetadata.projectId !== projectId) {
        return null
    }
    return { parentRunId: pendingMetadata.parentRunId, persisted: false }
}

/**
 * `computeChildDepth` walks the ancestry in Postgres, so it can only start from a row that is
 * already there. For a parent still pending its flush, seed the walk from the grandparent and count
 * the parent itself, rather than letting the guard silently under-count by one.
 */
async function computeInlineDepth({ parentRun, parentRunId }: ComputeInlineDepthParams): Promise<number> {
    if (parentRun.persisted) {
        return computeChildDepth(parentRunId)
    }
    if (isNil(parentRun.parentRunId)) {
        return 2
    }
    return await computeChildDepth(parentRun.parentRunId) + 1
}

async function computeChildDepth(parentRunId: string): Promise<number> {
    const query = `
        WITH RECURSIVE ancestors AS (
            SELECT id, "parentRunId", 1 AS depth
            FROM flow_run WHERE id = $1

            UNION ALL

            SELECT f.id, f."parentRunId", a.depth + 1
            FROM flow_run f
            INNER JOIN ancestors a ON f.id = a."parentRunId"
            WHERE a.depth < $2
        )
        SELECT MAX(depth) AS depth FROM ancestors
    `
    const results = await flowRunRepo().query(query, [parentRunId, INLINE_SUBFLOW_DEPTH_LIMIT + 1]) as { depth: string | null }[]
    const ancestorChainLength = Number(results[0]?.depth ?? 0)
    return ancestorChainLength + 1
}

type FindParentRunParams = {
    parentRunId: string
    projectId: string
    log: FastifyBaseLogger
}

type ComputeInlineDepthParams = {
    parentRun: ParentRun
    parentRunId: string
}

type ParentRun = {
    parentRunId?: string
    persisted: boolean
}
