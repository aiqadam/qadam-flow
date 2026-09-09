import {
    apId,
    FlowRun,
    FlowRunStatus,
    FlowStatus,
    FlowTriggerType,
    INLINE_SUBFLOW_DEPTH_LIMIT,
    isNil,
    StartInlineFlowRunRequest,
    StartInlineFlowRunResult,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowService } from '../../flows/flow/flow.service'
import { flowRunRepo } from '../../flows/flow-run/flow-run-service'
import { flowRunSideEffects } from '../../flows/flow-run/flow-run-side-effects'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'

const CALLABLE_FLOW_QADAM_NAME = '@aiqadam/qadam-subflows'
const CALLABLE_FLOW_TRIGGER_NAME = 'callableFlow'

export const inlineFlowRunService = (log: FastifyBaseLogger) => ({
    async start(request: StartInlineFlowRunRequest): Promise<StartInlineFlowRunResult> {
        // Never trust the caller's flowId ownership on its own — the flow must belong to
        // the SAME project as the worker's own current job. This is the exact check
        // that was missing from the earlier (reverted) attempt at this feature.
        const flow = await flowService(log).getOneOrThrow({ id: request.flowId, projectId: request.callerProjectId })
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

        const inlineDepth = await computeChildDepth(request.parentRunId)
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
            failParentOnFailure: true,
            status: FlowRunStatus.RUNNING,
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
