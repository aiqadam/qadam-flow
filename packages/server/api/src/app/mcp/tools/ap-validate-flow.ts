import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    isNil,
    McpToolDefinition,
    Permission,
    ProjectScopedMcpServer,
    Step,
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
    const callFlowSteps = flowStructureUtil.getAllSteps(trigger).filter(isCallFlowStep)
    if (callFlowSteps.length === 0) {
        return []
    }

    const payloadIssues = callFlowSteps.flatMap((step) => {
        const payload = readCallFlowInput(step).flowProps?.payload
        if (!isEmptyPayload(payload)) {
            return []
        }
        return [{
            category: 'subflow_payload' as const,
            stepName: step.name,
            message: `"${step.displayName}" calls a subflow with an empty payload — the child will run with no arguments. Set flowProps.payload with ap_update_step.`,
        }]
    })

    const inlineTargets = callFlowSteps.filter(step => readCallFlowInput(step).executionMode === INLINE_EXECUTION_MODE)
    const pauseIssues = await Promise.all(inlineTargets.map(async (step) => {
        const externalId = readCallFlowInput(step).flow?.externalId
        if (isNil(externalId)) {
            return []
        }
        const pausingStep = await findPausingStepInCallGraph({ rootExternalId: externalId, projectId, log })
        if (isNil(pausingStep)) {
            return []
        }
        return [{
            category: 'inline_pause' as const,
            stepName: step.name,
            message: `"${step.displayName}" runs its subflow inline, but "${pausingStep.flowName}" pauses at "${pausingStep.stepDisplayName}" (${pausingStep.reason}). An inline child has no queue job to resume from — switch this step to Queue execution mode.`,
        }]
    }))

    return [...payloadIssues, ...pauseIssues.flat()]
}

// Walks the inline call graph the way the engine executes it: an inline child runs inside the
// parent's own run, so its steps — and its own inline children — belong to this check, while a
// Queue-mode child runs as a separate job and is not walked into (it only matters here because
// waiting on one is itself a pause).
async function findPausingStepInCallGraph({ rootExternalId, projectId, log }: {
    rootExternalId: string
    projectId: string
    log: FastifyBaseLogger
}): Promise<PausingStep | null> {
    const visited = new Set<string>()
    let frontier = [rootExternalId]

    while (frontier.length > 0) {
        const unvisited = frontier.filter(externalId => !visited.has(externalId))
        if (unvisited.length === 0) {
            return null
        }
        unvisited.forEach(externalId => visited.add(externalId))

        // The draft is what the author is about to publish, which is what a pre-publish gate should
        // judge — `flowService.list` defaults to DRAFT for exactly that reason.
        const flows = await flowService(log).list({ projectIds: [projectId], externalIdsOrIds: unvisited })
        const nextFrontier: string[] = []

        for (const flow of flows.data) {
            for (const step of flowStructureUtil.getAllSteps(flow.version.trigger)) {
                if ('skip' in step && step.skip === true) {
                    continue
                }
                const reason = readPauseReason(step)
                if (!isNil(reason)) {
                    return { flowName: flow.version.displayName, stepDisplayName: step.displayName, reason }
                }
                if (isCallFlowStep(step) && readCallFlowInput(step).executionMode === INLINE_EXECUTION_MODE) {
                    const childExternalId = readCallFlowInput(step).flow?.externalId
                    if (!isNil(childExternalId)) {
                        nextFrontier.push(childExternalId)
                    }
                }
            }
        }
        frontier = nextFrontier
    }
    return null
}

function readPauseReason(step: Step): string | null {
    if (!isQadamStep(step)) {
        return null
    }
    const { qadamName, actionName } = step.settings
    if (isCallFlowStep(step)) {
        const input = readCallFlowInput(step)
        const waitsOnQueuedChild = input.executionMode !== INLINE_EXECUTION_MODE && input.waitForResponse === true
        return waitsOnQueuedChild ? 'a Queue-mode Call Flow that waits for a response' : null
    }
    if (qadamName === DELAY_QADAM && actionName === DELAY_FOR_ACTION) {
        return readDelayForPauseReason(step)
    }
    const reason = ALWAYS_PAUSING_ACTIONS[`${qadamName}:${actionName}`]
    return reason ?? null
}

// `delayFor` only pauses above DELAY_PAUSE_THRESHOLD_MS; below it the engine just sleeps in
// process, which an inline child can do. The amount and unit can be template expressions, and an
// amount that is not statically known is reported rather than assumed safe — a delay whose value
// arrives at run time is exactly the case that would otherwise fail on a user.
function readDelayForPauseReason(step: QadamStep): string | null {
    const input = (step.settings.input ?? {}) as { delayFor?: unknown, unit?: unknown }
    const unitMs = DELAY_UNIT_MS[String(input.unit ?? 'seconds')]
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
    return (step.settings.input ?? {}) as CallFlowInput
}

function isEmptyPayload(payload: unknown): boolean {
    if (isNil(payload) || payload === '') {
        return true
    }
    if (Array.isArray(payload)) {
        return payload.length === 0
    }
    if (typeof payload === 'object') {
        return Object.keys(payload as Record<string, unknown>).length === 0
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
const ALWAYS_PAUSING_ACTIONS: Record<string, string> = {
    [`${DELAY_QADAM}:delay_until`]: 'a Delay Until',
    '@aiqadam/qadam-approval:wait_for_approval': 'a Wait for Approval',
    '@aiqadam/qadam-webhook:return_response_and_wait_for_next_webhook': 'a webhook wait',
}

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
    flow?: { externalId?: string }
    flowProps?: { payload?: unknown }
    executionMode?: string
    waitForResponse?: boolean
}

type PausingStep = {
    flowName: string
    stepDisplayName: string
    reason: string
}

type ValidationResult = {
    totalSteps: number
    validSteps: number
    invalidSteps: number
    skippedSteps: number
    issues: ValidationIssue[]
}
