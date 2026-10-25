import { agentToolPins, NPM_PACKAGE_NAME_MAX_LENGTH } from '@aiqadam/server-utils'
import { FlowActionType, flowQadamUtil, flowStructureUtil, FlowTriggerType, FlowVersion, isNil, MAX_AGENT_TOOL_PINS, NPM_PACKAGE_NAME_REGEX, QadamPackage, qadamVersionParser, tryCatch, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { CodeArtifact } from '../../cache/code/code-builder'
import { provisioner } from '../../cache/provisioner'
import { PieceNotFoundError, qadamCache } from '../../cache/qadams/qadam-cache'
import { MALFORMED_PIN } from './malformed-pin'

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
        // Over the cap is a flow-level refusal, not a pin the filesystem cannot hold: it fails
        // closed rather than provisioning a prefix and letting the engine load the rest (#879).
        if (error instanceof TooManyAgentToolPinsError) {
            log.error({ error: String(error), flowId, projectId, stepName: error.stepName }, 'A flow step has more agent tools than the limit; skipping provisioning')
            return { provisioned: false, unavailableQadam: `more than ${MAX_AGENT_TOOL_PINS} agent tools`, usedBy: `the step ${error.stepName}` }
        }
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
    // A flow saved before the cap, or imported, can carry more tools than the write path allows.
    // Provisioning a prefix would let the engine load the rest outside the API's platform-scoped
    // pin check, so refuse the flow instead (#879).
    const overCapStep = steps.find((step) => step.type === FlowActionType.PIECE && flowQadamUtil.countAgentToolPins({ input: step.settings.input }) > MAX_AGENT_TOOL_PINS)
    if (!isNil(overCapStep)) {
        throw new TooManyAgentToolPinsError({ stepName: overCapStep.name })
    }
    const stepPins = steps
        .filter((step) => step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
        .map((step): QadamPin => ({ qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion, usedBy: `the step ${step.name}` }))
    // The engine loads an agent tool's qadam by its own pin, like a step's, so it is provisioned like one (#779).
    const toolPins = steps
        .filter((step) => step.type === FlowActionType.PIECE)
        .flatMap((step) => agentToolPins.fromInput({ input: step.settings.input }).map((tool): QadamPin => ({
            qadamName: tool.qadamName,
            qadamVersion: tool.qadamVersion,
            usedBy: `an agent tool of step ${step.name}`,
        })))

    return mapWithConcurrency({
        items: uniquePins({ pins: [...stepPins, ...toolPins] }),
        limit: MAX_CONCURRENT_PIN_LOOKUPS,
        fn: async (pin) => {
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
        },
    })
}

export class TooManyAgentToolPinsError extends Error {
    public readonly stepName: string

    constructor({ stepName }: { stepName: string }) {
        super(`Step ${stepName} has more than ${MAX_AGENT_TOOL_PINS} agent tools`)
        this.name = 'TooManyAgentToolPinsError'
        this.stepName = stepName
    }
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
    const isWellFormed = qadamName.length <= NPM_PACKAGE_NAME_MAX_LENGTH && NPM_PACKAGE_NAME_REGEX.test(qadamName) && qadamVersionParser.parsePin({ pin: qadamVersion }) !== null
    return isWellFormed ? `${qadamName}@${qadamVersion}` : MALFORMED_PIN
}

function uniquePins({ pins }: { pins: QadamPin[] }): QadamPin[] {
    // Keyed on the pair, not on `name@version`: a tool is free text, and one named '' at version
    // 'scope/foo@1.0.0' would read as the valid pin @scope/foo@1.0.0 and hide behind it.
    const byKey = new Map(pins.map((pin) => [JSON.stringify([pin.qadamName, pin.qadamVersion]), pin]))
    return [...byKey.values()]
}

// Each pinned qadam is one `getQadam` RPC, and the API resolves every one of them; a flow with
// many tool pins used to send them all at once (#879). The bound is small on purpose: it is the
// API's event loop the fan-out competes for.
const MAX_CONCURRENT_PIN_LOOKUPS = 8

async function mapWithConcurrency<T, R>({ items, limit, fn }: {
    items: T[]
    limit: number
    fn: (item: T) => Promise<R>
}): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0
    // The first failure is the provisioning result; there is nothing left worth fetching, so the
    // other workers stop pulling instead of hitting the API for the rest of the flow (#879).
    let stopped = false
    let failed = false
    let firstError: unknown
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!stopped && nextIndex < items.length) {
            const index = nextIndex++
            try {
                results[index] = await fn(items[index])
            }
            catch (error) {
                stopped = true
                if (!failed) {
                    failed = true
                    firstError = error
                }
            }
        }
    })
    // Awaiting every worker, even after one has failed, is what it takes to actually stop: a
    // worker that was mid-`fn()` (e.g. writing the on-disk qadam cache) when a sibling threw used
    // to keep running after this function returned, racing the caller's own cleanup of that same
    // cache entry (ENOTEMPTY in flow-helpers-malformed-tool-pin.test.ts, flaky under CI load).
    await Promise.all(workers)
    if (failed) {
        throw firstError
    }
    return results
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
    // `usedBy` says what holds the pin: `the step step_2` or `an agent tool of step step_3`.
    | { provisioned: false, unavailableQadam: string, usedBy: string }
