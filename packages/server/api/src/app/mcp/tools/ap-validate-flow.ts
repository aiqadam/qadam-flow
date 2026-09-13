import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    isNil,
    McpToolDefinition,
    Permission,
    ProjectScopedMcpServer,
    Step,
    unique,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { mcpUtils } from './mcp-utils'

export const apValidateFlowTool = (mcp: ProjectScopedMcpServer, log: FastifyBaseLogger): McpToolDefinition => {
    return {
        title: 'ap_validate_flow',
        permission: Permission.READ_FLOW,
        description: 'Validate a flow for structural issues without publishing. Checks step validity, template references, and empty branches. Returns a detailed report with all issues found. Use this before ap_lock_and_publish to catch problems early.',
        inputSchema: validateFlowInput.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (args) => {
            try {
                const { flowId } = validateFlowInput.parse(args)

                const flow = await flowService(log).getOnePopulated({ id: flowId, projectId: mcp.projectId })
                if (isNil(flow)) {
                    return { content: [{ type: 'text', text: '❌ Flow not found.' }] }
                }

                const structural = validateFlow({ trigger: flow.version.trigger })
                const callFlowIssues = await validateCallFlowSteps({
                    trigger: flow.version.trigger,
                    projectId: mcp.projectId,
                    log,
                })
                const result = { ...structural, issues: [...structural.issues, ...callFlowIssues] }
                return {
                    content: [{ type: 'text', text: formatValidationResult({ result, flowDisplayName: flow.version.displayName }) }],
                    structuredContent: {
                        valid: result.issues.length === 0 && result.validSteps > 0,
                        totalSteps: result.totalSteps,
                        validSteps: result.validSteps,
                        invalidSteps: result.invalidSteps,
                        skippedSteps: result.skippedSteps,
                        issues: result.issues.map(i => ({ category: i.category, stepName: i.stepName, message: i.message })),
                    },
                }
            }
            catch (err) {
                return mcpUtils.mcpToolError('Flow validation failed', err)
            }
        },
    }
}

const validateFlowInput = z.object({
    flowId: z.string().describe('The id of the flow to validate. Use ap_list_flows to find it.'),
})

function validateFlow({ trigger }: { trigger: Step }): ValidationResult {
    const allSteps = flowStructureUtil.getAllSteps(trigger)
    const allStepNames = new Set(allSteps.map(s => s.name))
    const issues: ValidationIssue[] = []

    if (trigger.type === FlowTriggerType.EMPTY) {
        issues.push({ category: 'step_validity', stepName: 'trigger', message: 'Trigger is not configured (use ap_update_trigger).' })
    }

    const seenSteps = new Set<string>()
    let validCount = 0
    let invalidCount = 0
    let skippedCount = 0

    for (const step of allSteps) {
        const isSkipped = 'skip' in step && step.skip === true

        if (isSkipped) {
            skippedCount++
        }
        else if (step.valid) {
            validCount++
        }
        else {
            invalidCount++
            if (!flowStructureUtil.isTrigger(step.type)) {
                issues.push({ category: 'step_validity', stepName: step.name, message: `"${step.displayName}" is invalid (use ap_update_step to fix).` })
            }
        }

        const strings = collectStringValues({ step })
        const seenRefs = new Set<string>()
        for (const str of strings) {
            const refs = extractReferencedStepNames({ value: str })
            for (const ref of refs) {
                if (seenRefs.has(ref)) continue
                seenRefs.add(ref)
                if (!allStepNames.has(ref)) {
                    issues.push({ category: 'template_reference', stepName: step.name, message: `"${step.displayName}" references "{{${ref}...}}" which does not exist in the flow.` })
                }
                else if (!seenSteps.has(ref)) {
                    issues.push({ category: 'template_reference', stepName: step.name, message: `"${step.displayName}" references "{{${ref}...}}" which comes AFTER it in execution order.` })
                }
            }
        }

        if (step.type === FlowActionType.ROUTER) {
            const { children, settings } = step
            const branches = settings.branches ?? []
            for (let i = 0; i < children.length; i++) {
                if (isNil(children[i])) {
                    const branchName = branches[i]?.branchName ?? `Branch ${i}`
                    issues.push({ category: 'empty_branch', stepName: step.name, message: `"${step.displayName}" has empty branch: "${branchName}".` })
                }
            }
        }

        seenSteps.add(step.name)
    }

    return { totalSteps: allSteps.length, validSteps: validCount, invalidSteps: invalidCount, skippedSteps: skippedCount, issues }
}

// `ap_validate_flow` is the only pre-publish gate an automated flow builder has, and until now it
// could not see the two ways a `callFlow` step fails at run time while reading as configured: an
// empty argument set, and an inline child that pauses. Both are decidable statically — the payload
// is right there in the step, and the call graph is already stored on the server (#391).
async function validateCallFlowSteps({ trigger, projectId, log }: {
    trigger: Step
    projectId: string
    log: FastifyBaseLogger
}): Promise<ValidationIssue[]> {
    // A skipped step does not run, so it cannot fail — which is already how `validateFlow` treats
    // one, and how the callee walk treats a skipped step inside a subflow. Judging a skipped
    // `callFlow` step more harshly than either would be the odd one out.
    const callFlowSteps = flowStructureUtil.getAllSteps(trigger)
        .filter(step => !('skip' in step && step.skip === true))
        .filter(isCallFlowStep)
    if (callFlowSteps.length === 0) {
        return []
    }

    const roots = unique(callFlowSteps
        .map(step => readCallFlowInput(step).externalId)
        .filter((externalId): externalId is string => !isNil(externalId)))
    if (roots.length === 0) {
        return []
    }

    const graph = await loadCallGraph({ roots, projectId, log })

    // An empty payload is only a defect when the callee actually takes arguments. A callable flow
    // that takes none legitimately stores `{}` — flagging that would leave the flow permanently
    // "not ready to publish" with no way to suppress it, and `structuredContent.valid` is derived
    // from the issue count, so an agent would loop trying to fix a non-problem.
    const payloadIssues = callFlowSteps.flatMap((step) => {
        const input = readCallFlowInput(step)
        const externalId = input.externalId
        const callee = isNil(externalId) ? undefined : graph.get(externalId)
        if (!isEmptyPayload(input.payload) || isNil(callee) || !callee.expectsArguments) {
            return []
        }
        return [{
            category: 'subflow_payload' as const,
            stepName: step.name,
            message: `"${step.displayName}" calls a subflow with an empty payload, but that subflow declares arguments — the child will run with none. Set flowProps.payload with ap_update_step.`,
        }]
    })

    const inlineTargets = callFlowSteps.filter(step => readCallFlowInput(step).executionMode === INLINE_EXECUTION_MODE)
    const pauseIssues = inlineTargets.flatMap((step) => {
        const externalId = readCallFlowInput(step).externalId
        const pausingStep = isNil(externalId) ? null : findPausingFlow({ root: externalId, graph })
        if (isNil(pausingStep)) {
            return []
        }
        return [{
            category: 'inline_pause' as const,
            stepName: step.name,
            message: `"${step.displayName}" runs its subflow inline, but "${pausingStep.flowName}" pauses at "${pausingStep.stepDisplayName}" (${pausingStep.reason}). An inline child has no queue job to resume from — switch this step to Queue execution mode.`,
        }]
    })

    return [...payloadIssues, ...pauseIssues]
}

// Every reachable flow is fetched exactly once, for all roots together, and the per-root answer is
// then read off the in-memory graph. Walking each root separately would refetch the shared part of
// the graph once per root — and `flowService.list` returns whole flow versions, so that is real
// bandwidth and heap, driven by a caller who only needs READ_FLOW.
async function loadCallGraph({ roots, projectId, log }: {
    roots: string[]
    projectId: string
    log: FastifyBaseLogger
}): Promise<Map<string, FlowNode>> {
    const graph = new Map<string, FlowNode>()
    let frontier = roots

    while (frontier.length > 0) {
        const unresolved = unique(frontier.filter(externalId => !graph.has(externalId)))
        if (unresolved.length === 0) {
            return graph
        }

        // The draft is what the author is about to publish, which is what a pre-publish gate should
        // judge — `flowService.list` defaults to DRAFT for exactly that reason.
        const flows = await flowService(log).list({ projectIds: [projectId], externalIdsOrIds: unresolved })
        for (const reference of unresolved) {
            const flow = flows.data.find(candidate => candidate.externalId === reference || candidate.id === reference)
            // A reference that resolves to nothing — deleted, or belonging to another project — is
            // recorded as unknown so it is never queried again, and reported as neither pausing nor
            // safe. It is indistinguishable from a non-existent id to the caller either way.
            graph.set(reference, isNil(flow) ? UNRESOLVED_FLOW : readFlowNode(flow))
        }
        frontier = unresolved.flatMap(reference => graph.get(reference)?.inlineChildren ?? [])
    }
    return graph
}

// Reads the one fact the walk needs from a flow: whether it pauses on its own, and which flows it
// runs inline. A Queue-mode child runs as a separate job and is not an edge here — it only matters
// because waiting on one is itself a pause, which `readPauseReason` reports.
function readFlowNode(flow: { version: { displayName: string, trigger: Step } }): FlowNode {
    const steps = flowStructureUtil.getAllSteps(flow.version.trigger)
        .filter(step => !('skip' in step && step.skip === true))
    const expectsArguments = !isEmptyPayload(readCallableFlowSampleData(flow.version.trigger))
    const pausingStep = steps.reduce<PausingStep | null>((found, step) => {
        if (!isNil(found)) {
            return found
        }
        const reason = readPauseReason(step)
        return isNil(reason)
            ? null
            : { flowName: flow.version.displayName, stepDisplayName: step.displayName, reason }
    }, null)
    const inlineChildren = steps.flatMap((step) => {
        if (!isCallFlowStep(step) || readCallFlowInput(step).executionMode !== INLINE_EXECUTION_MODE) {
            return []
        }
        const childExternalId = readCallFlowInput(step).externalId
        return isNil(childExternalId) ? [] : [childExternalId]
    })
    return { pausingStep, inlineChildren, expectsArguments }
}

// The `Callable Flow` trigger's `exampleData.sampleData` is the child's declared argument shape —
// it is what `call-flow.ts` seeds the parent's payload field from. Empty means the child takes no
// arguments, so a parent calling it with none is correct rather than broken.
function readCallableFlowSampleData(trigger: Step): unknown {
    if (trigger.type !== FlowTriggerType.PIECE) {
        return undefined
    }
    const exampleData = trigger.settings.input?.exampleData
    return isPlainObject(exampleData) ? exampleData.sampleData : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findPausingFlow({ root, graph }: { root: string, graph: Map<string, FlowNode> }): PausingStep | null {
    const seen = new Set<string>()
    const pending = [root]

    while (pending.length > 0) {
        const reference = pending.pop()
        if (isNil(reference) || seen.has(reference)) {
            continue
        }
        seen.add(reference)
        const node = graph.get(reference)
        if (isNil(node)) {
            continue
        }
        if (!isNil(node.pausingStep)) {
            return node.pausingStep
        }
        pending.push(...node.inlineChildren)
    }
    return null
}

function readPauseReason(step: Step): string | null {
    if (!isQadamStep(step)) {
        return null
    }
    const { qadamName, actionName, input } = step.settings
    if (isCallFlowStep(step)) {
        const callFlowInput = readCallFlowInput(step)
        const waitsOnQueuedChild = callFlowInput.executionMode !== INLINE_EXECUTION_MODE && callFlowInput.waitForResponse
        return waitsOnQueuedChild ? 'a Queue-mode Call Flow that waits for a response' : null
    }
    if (qadamName === DELAY_QADAM && actionName === DELAY_FOR_ACTION) {
        return readDelayForPauseReason(step)
    }
    // `transcribe` only waits when the author asked it to wait; submitting and moving on is the
    // default, and flagging that would be a false "cannot publish" on a flow that works.
    if (qadamName === ASSEMBLYAI_QADAM && actionName === ASSEMBLYAI_TRANSCRIBE_ACTION) {
        const waitUntilReady = (input ?? {}).wait_until_ready
        return waitUntilReady === true || waitUntilReady === 'true'
            ? 'an AssemblyAI transcription set to wait until it is ready'
            : null
    }
    const reason = ALWAYS_PAUSING_ACTIONS[`${qadamName}:${actionName}`]
    return reason ?? null
}

// `delayFor` only pauses above DELAY_PAUSE_THRESHOLD_MS; below it the engine just sleeps in
// process, which an inline child can do. The amount and unit can be template expressions, and an
// amount that is not statically known is reported rather than assumed safe — a delay whose value
// arrives at run time is exactly the case that would otherwise fail on a user.
function readDelayForPauseReason(step: QadamStep): string | null {
    const input = step.settings.input ?? {}
    // `hasOwn`, not a bare index: `unit: "constructor"` would otherwise return an inherited
    // function, make `isNil(unitMs)` false, and leave `amount * unitMs` as NaN — reporting the step
    // as not pausing, which is the one answer a flow author must not be given by accident.
    const unitName = String(input.unit ?? 'seconds')
    const unitMs = Object.hasOwn(DELAY_UNIT_MS, unitName) ? DELAY_UNIT_MS[unitName] : undefined
    const amount = typeof input.delayFor === 'number' ? input.delayFor : Number(input.delayFor)
    if (isNil(unitMs) || !Number.isFinite(amount)) {
        return 'a Delay whose duration is not known until run time, so it may pause'
    }
    return amount * unitMs > DELAY_PAUSE_THRESHOLD_MS ? 'a Delay longer than 10 seconds' : null
}

function isQadamStep(step: Step): step is QadamStep {
    return step.type === FlowActionType.PIECE
}

function isCallFlowStep(step: Step): step is QadamStep {
    return isQadamStep(step)
        && step.settings.qadamName === SUBFLOWS_QADAM
        && step.settings.actionName === CALL_FLOW_ACTION
}

function readCallFlowInput(step: QadamStep): CallFlowInput {
    const input = step.settings.input ?? {}
    const flow = isPlainObject(input.flow) ? input.flow : undefined
    const flowProps = isPlainObject(input.flowProps) ? input.flowProps : undefined
    return {
        externalId: typeof flow?.externalId === 'string' ? flow.externalId : undefined,
        payload: flowProps?.payload,
        executionMode: typeof input.executionMode === 'string' ? input.executionMode : undefined,
        waitForResponse: input.waitForResponse === true,
    }
}

function isEmptyPayload(payload: unknown): boolean {
    if (isNil(payload) || payload === '') {
        return true
    }
    if (Array.isArray(payload)) {
        return payload.length === 0
    }
    if (isPlainObject(payload)) {
        return Object.keys(payload).length === 0
    }
    return false
}

function collectStringValues({ step }: { step: Step }): string[] {
    const result: string[] = []

    if ('settings' in step && typeof step.settings === 'object' && step.settings !== null) {
        const settings = step.settings as Record<string, unknown>

        if ('input' in settings && typeof settings.input === 'object' && settings.input !== null) {
            walkValues(settings.input, (val) => {
                if (typeof val === 'string') result.push(val)
            })
        }

        if ('items' in settings && typeof settings.items === 'string') {
            result.push(settings.items)
        }

        if ('branches' in settings && Array.isArray(settings.branches)) {
            for (const branch of settings.branches) {
                if (typeof branch === 'object' && branch !== null && 'conditions' in branch && Array.isArray(branch.conditions)) {
                    for (const group of branch.conditions) {
                        if (!Array.isArray(group)) continue
                        for (const cond of group) {
                            if (typeof cond === 'object' && cond !== null) {
                                if ('firstValue' in cond && typeof cond.firstValue === 'string') result.push(cond.firstValue)
                                if ('secondValue' in cond && typeof cond.secondValue === 'string') result.push(cond.secondValue)
                            }
                        }
                    }
                }
            }
        }
    }

    return result
}

function walkValues(obj: unknown, fn: (val: unknown) => void): void {
    if (obj === null || obj === undefined) return
    fn(obj)
    if (Array.isArray(obj)) {
        for (const item of obj) walkValues(item, fn)
    }
    else if (typeof obj === 'object') {
        for (const val of Object.values(obj)) walkValues(val, fn)
    }
}

function extractReferencedStepNames({ value }: { value: string }): string[] {
    const regex = /\{\{(\w+)/g
    const names = new Set<string>()
    let match
    while ((match = regex.exec(value)) !== null) {
        const name = match[1]
        if (name !== 'connections') {
            names.add(name)
        }
    }
    return [...names]
}

const SUBFLOWS_QADAM = '@aiqadam/qadam-subflows'
const CALL_FLOW_ACTION = 'callFlow'
const INLINE_EXECUTION_MODE = 'inline'
const DELAY_QADAM = '@aiqadam/qadam-delay'
const DELAY_FOR_ACTION = 'delayFor'
const DELAY_PAUSE_THRESHOLD_MS = 10 * 1000
const DELAY_UNIT_MS: Record<string, number> = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
}
const UNRESOLVED_FLOW: FlowNode = { pausingStep: null, inlineChildren: [], expectsArguments: false }
// Derived by grepping every qadam for `waitForWaitpoint` — creating a waitpoint is not enough
// (`approval:create_approval_links` does that and keeps running); waiting on one is what pauses.
//
// This is an allowlist, and it is the check's known limit: a qadam added later that pauses will
// validate green here and still fail at run time with the `inline-flow-executor.ts` error. Making
// it exhaustive needs a declared marker on the action rather than a table — #426, not guessed at
// here, because a wrong entry produces a false "cannot publish" on a flow that works.
//
// Second limit, tracked in the same ticket: in the conditional cases `wait_until_ready` and
// `waitForResponse` are read as literals, so a value bound to a template expression reads as "does
// not pause" while the engine's plain truthiness check would pause. `delayFor` is the one that
// reports rather than assumes when its value is not statically known; the other two assume safe.
// Both are still strictly better than no check at all, but neither is a guarantee.
const ALWAYS_PAUSING_ACTIONS: Record<string, string> = {
    [`${DELAY_QADAM}:delay_until`]: 'a Delay Until',
    '@aiqadam/qadam-approval:wait_for_approval': 'a Wait for Approval',
    '@aiqadam/qadam-webhook:return_response_and_wait_for_next_webhook': 'a webhook wait',
    '@aiqadam/qadam-slack:request_approval_message': 'a Slack approval request',
    '@aiqadam/qadam-slack:request_approval_direct_message': 'a Slack approval request',
    '@aiqadam/qadam-microsoft-teams:request_approval_direct_message': 'a Teams approval request',
    '@aiqadam/qadam-microsoft-teams:request_approval_in_channel': 'a Teams approval request',
    '@aiqadam/qadam-discord:request_approval_message': 'a Discord approval request',
    '@aiqadam/qadam-telegram-bot:request_approval_message': 'a Telegram approval request',
    '@aiqadam/qadam-gmail:request_approval_in_mail': 'a Gmail approval request',
    '@aiqadam/qadam-microsoft-outlook:request_approval_in_mail': 'an Outlook approval request',
}
const ASSEMBLYAI_QADAM = '@aiqadam/qadam-assemblyai'
const ASSEMBLYAI_TRANSCRIBE_ACTION = 'transcribe'

const CATEGORY_ORDER: ValidationIssue['category'][] = ['step_validity', 'template_reference', 'empty_branch', 'subflow_payload', 'inline_pause']
const CATEGORY_LABELS: Record<ValidationIssue['category'], string> = {
    step_validity: 'Step Validity',
    template_reference: 'Template References',
    empty_branch: 'Empty Branches',
    subflow_payload: 'Subflow Payloads',
    inline_pause: 'Inline Subflows That Pause',
}

function formatValidationResult({ result, flowDisplayName }: { result: ValidationResult, flowDisplayName: string }): string {
    if (result.issues.length === 0 && result.validSteps > 0) {
        const skippedNote = result.skippedSteps > 0 ? `, ${result.skippedSteps} skipped` : ''
        return `✅ Flow "${flowDisplayName}" is ready to publish (${result.totalSteps} steps, ${result.validSteps} valid${skippedNote}).`
    }

    if (result.issues.length === 0 && result.validSteps === 0) {
        return `⚠️ Flow "${flowDisplayName}" has no valid steps (${result.totalSteps} total). Configure the trigger and actions before publishing.`
    }

    const grouped = new Map<ValidationIssue['category'], ValidationIssue[]>()
    for (const issue of result.issues) {
        const list = grouped.get(issue.category) ?? []
        list.push(issue)
        grouped.set(issue.category, list)
    }

    const lines: string[] = []
    lines.push(`⚠️ Flow "${flowDisplayName}" has ${result.issues.length} issue(s):`)
    lines.push('')

    for (const category of CATEGORY_ORDER) {
        const issues = grouped.get(category)
        if (issues && issues.length > 0) {
            lines.push(`${CATEGORY_LABELS[category]}:`)
            for (const issue of issues) lines.push(`- ${issue.stepName}: ${issue.message}`)
            lines.push('')
        }
    }

    lines.push(`Summary: ${result.totalSteps} total, ${result.validSteps} valid, ${result.invalidSteps} invalid, ${result.skippedSteps} skipped`)

    return lines.join('\n')
}

type ValidationIssue = {
    category: 'step_validity' | 'template_reference' | 'empty_branch' | 'subflow_payload' | 'inline_pause'
    stepName: string
    message: string
}

type QadamStep = Extract<Step, { type: FlowActionType.PIECE }>

type CallFlowInput = {
    externalId: string | undefined
    payload: unknown
    executionMode: string | undefined
    waitForResponse: boolean
}

type PausingStep = {
    flowName: string
    stepDisplayName: string
    reason: string
}

type FlowNode = {
    expectsArguments: boolean
    pausingStep: PausingStep | null
    inlineChildren: string[]
}

type ValidationResult = {
    totalSteps: number
    validSteps: number
    invalidSteps: number
    skippedSteps: number
    issues: ValidationIssue[]
}
