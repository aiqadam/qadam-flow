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
}): Promise<ProvisionFlowQadamsResult> {
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
        // What each of the six callers does with the result instead: `execute-trigger-hook` reports
        // the pin to the enable/publish path so that fails loudly (except ON_DISABLE, which must
        // still succeed); `execute-flow` and `create-sandbox-for-job` mark the run FAILED;
        // `execute-polling`, `execute-webhook` and `renew-webhook` are fire-and-forget and skip
        // this tick, which is the one genuinely silent case — `ap_validate_flow` reports the pin so
        // it is visible without waiting for a tick that never fires.
        log.error({ error: String(error), flowId, projectId }, 'Flow step is pinned to a qadam version this image does not have; skipping provisioning')
        return { provisioned: false, unavailableQadam: `${error.qadamName}@${error.qadamVersion}` }
    }
    return { provisioned: true }
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

export type ProvisionFlowQadamsResult =
    | { provisioned: true }
    | { provisioned: false, unavailableQadam: string }
