import { agentToolPins } from '@aiqadam/server-utils'
import { FlowActionType, flowStructureUtil, FlowTriggerType, FlowVersion, NPM_PACKAGE_NAME_REGEX, QadamPackage, qadamVersionParser, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
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
        const pieces = await extractQadamPackages({ flowVersion, platformId, log, apiClient })
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
        log.error({ error: String(error), flowId, projectId, usedBy: error.usedBy }, 'A flow step or agent tool is pinned to a qadam version this image does not have; skipping provisioning')
        return { provisioned: false, unavailableQadam: describePin({ qadamName: error.qadamName, qadamVersion: error.qadamVersion }), usedBy: error.usedBy ?? 'a step or an agent tool' }
    }
    return { provisioned: true }
}

export async function extractQadamPackages({ flowVersion, platformId, log, apiClient }: ExtractQadamPackagesParams): Promise<QadamPackage[]> {
    const steps = flowStructureUtil.getAllSteps(flowVersion.trigger)
    const stepPins = steps
        .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
        .map((step): QadamPin => ({ qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion, usedBy: `step ${step.name}` }))
    // The engine loads an agent tool's qadam by its own pin, like a step's, so it is provisioned like one (#779).
    const toolPins = steps
        .filter((step) => step.type === FlowActionType.PIECE)
        .flatMap((step) => agentToolPins.fromInput({ input: step.settings.input }).map((tool): QadamPin => ({
            qadamName: tool.qadamName,
            qadamVersion: tool.qadamVersion,
            usedBy: `agent tool of step ${step.name}`,
        })))

    return Promise.all(
        uniquePins({ pins: [...stepPins, ...toolPins] }).map(async (pin) => {
            const { data, error } = await tryCatch(() => qadamCache(log, apiClient).getPiece({
                qadamName: pin.qadamName,
                qadamVersion: pin.qadamVersion,
                platformId,
            }))
            if (error instanceof PieceNotFoundError) {
                throw new PieceNotFoundError(error.qadamName, error.qadamVersion, { usedBy: pin.usedBy })
            }
            if (error) {
                throw error
            }
            return data
        }),
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

// The pin as it goes into an error an MCP client reads. An agent tool's name and version are not
// validated when stored, so free text that is no package name or no version is not echoed (#779).
function describePin({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }): string {
    const isWellFormed = NPM_PACKAGE_NAME_REGEX.test(qadamName) && qadamVersionParser.parsePin({ pin: qadamVersion }) !== null
    return isWellFormed ? `${qadamName}@${qadamVersion}` : 'a malformed pin'
}

function uniquePins({ pins }: { pins: QadamPin[] }): QadamPin[] {
    const byKey = new Map(pins.map((pin) => [`${pin.qadamName}@${pin.qadamVersion}`, pin]))
    return [...byKey.values()]
}

type QadamPin = {
    qadamName: string
    qadamVersion: string
    usedBy: string
}

type ExtractQadamPackagesParams = {
    flowVersion: FlowVersion
    platformId: string
    log: Logger
    apiClient: WorkerToApiContract
}

export type ProvisionFlowQadamsResult =
    | { provisioned: true }
    // `usedBy` says what holds the pin: `step step_2` or `agent tool of step step_3`.
    | { provisioned: false, unavailableQadam: string, usedBy: string }
