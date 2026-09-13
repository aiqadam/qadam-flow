import { FlowActionType, flowStructureUtil, FlowTriggerType, FlowVersion, QadamPackage, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { CodeArtifact } from '../../cache/code/code-builder'
import { provisioner } from '../../cache/provisioner'
import { PieceNotFoundError, qadamCache } from '../../cache/qadams/qadam-cache'

export async function provisionFlowPieces(params: {
    flowVersion: FlowVersion
    platformId: string
    flowId: string
    projectId: string
    log: Logger
    apiClient: WorkerToApiContract
}): Promise<boolean> {
    const { flowVersion, platformId, flowId, projectId, log, apiClient } = params
    const { error } = await tryCatch(async () => {
        const pieces = await extractQadamPackages(flowVersion, platformId, log, apiClient)
        const codeSteps = extractCodeArtifacts(flowVersion)
        await provisioner(log, apiClient).provision({ pieces, codeSteps })
    })
    if (error) {
        if (!(error instanceof PieceNotFoundError)) {
            throw error
        }
        // Deliberately does NOT disable the flow. Disabling it from here was self-recursive: the
        // status change fans out an ON_DISABLE trigger hook, that hook provisions the same flow,
        // fails on the same missing piece, and asks for another disable — which then blocks on the
        // status-change lock the first one still holds, until the caller's 60 s TRIGGER_TIMEOUT
        // unwinds it. Measured p90 was 60 s against a p50 of 88 ms, and it also made publishing
        // such a flow over MCP hang for a full minute (#432).
        //
        // Every caller already handles `false`: the trigger-hook, polling, renew-webhook and
        // webhook jobs skip, and `execute-flow` marks the run FAILED. So a missing pin now costs
        // one clean, attributed failure per attempt instead of an unexplained self-disable whose
        // only trace was in worker logs. `ap_validate_flow` reports the pin so it is visible
        // before it ever gets this far.
        log.error({ error: String(error), flowId, projectId }, 'Flow step is pinned to a qadam version this image does not have; skipping provisioning')
        return false
    }
    return true
}

export async function extractQadamPackages(flowVersion: FlowVersion, platformId: string, log: Logger, apiClient: WorkerToApiContract): Promise<QadamPackage[]> {
    const pieceSteps = flowStructureUtil.getAllSteps(flowVersion.trigger)
        .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)

    return Promise.all(
        pieceSteps.map((step) =>
            qadamCache(log, apiClient).getPiece({
                qadamName: step.settings.qadamName,
                qadamVersion: step.settings.qadamVersion,
                platformId,
            }),
        ),
    )
}

export function extractCodeArtifacts(flowVersion: FlowVersion): CodeArtifact[] {
    return flowStructureUtil.getAllSteps(flowVersion.trigger)
        .filter((step) => step.type === FlowActionType.CODE)
        .map((step) => ({
            name: step.name,
            sourceCode: step.settings.sourceCode,
            flowVersionId: flowVersion.id,
            flowVersionState: flowVersion.state,
        }))
}
