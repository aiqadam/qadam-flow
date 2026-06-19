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
        log.warn({ error: String(error), flowId }, 'Flow disabled due to missing piece')
        const { error: disableError } = await tryCatch(
            () => apiClient.disableFlow({ flowId, projectId }),
        )
        if (disableError) {
            log.error({ error: String(disableError), flowId }, 'Failed to disable flow after missing piece')
        }
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
