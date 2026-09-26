import { PauseBehaviour, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    extractMustacheTokens,
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    isNil,
    localeUtil,
    LoopExecutionMode,
    LoopOnItemsAction,
    MAX_TRANSLATION_KEYS_PER_PROJECT,
    McpToolDefinition,
    parseTranslationToken,
    Permission,
    ProjectScopedMcpServer,
    RouterActionSettingsWithValidation,
    Step,
    TRANSLATION_KEY_REGEX,
    tryCatch,
    unique,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { flowService } from '../../flows/flow/flow.service'
import { projectService } from '../../project/project-service'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'
import { qadamPinUtil } from '../../qadams/metadata/qadam-pin-util'
import { translationService } from '../../translation/translation.service'
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
                const platformId = await projectService(log).getPlatformId(mcp.projectId)
                const [callFlowIssues, qadamVersionIssues, concurrentLoopIssues, translationIssues] = await Promise.all([
                    validateCallFlowSteps({
                        trigger: flow.version.trigger,
                        projectId: mcp.projectId,
                        platformId,
                        log,
                    }),
                    validatePinnedQadamVersions({
                        trigger: flow.version.trigger,
                        platformId,
                        log,
                    }),
                    validateConcurrentLoops({
                        trigger: flow.version.trigger,
                        flowName: flow.version.displayName,
                        platformId,
                        log,
                    }),
                    validateFlowTranslations({
                        trigger: flow.version.trigger,
                        localeSource: flow.version.localeSource,
                        projectId: mcp.projectId,
                        platformId,
                        log,
                    }),
                ])
                const allIssues = [...structural.issues, ...qadamVersionIssues, ...callFlowIssues, ...concurrentLoopIssues, ...translationIssues]
                const result = { ...structural, issues: allIssues }
                // A warning is reported in the output but never blocks `valid` or counts toward
                // "invalid" in the summary — today that is exactly (and only) the translation
                // categories that describe something the run can recover from at run time (a
                // fallback locale, a self-referential localeSource), never the ones that will
                // actually throw.
                const errorIssues = allIssues.filter((issue) => issue.severity !== 'warning')
                const warningIssues = allIssues.filter((issue) => issue.severity === 'warning')
                const valid = errorIssues.length === 0 && result.validSteps > 0
                return {
                    content: [{ type: 'text', text: formatValidationResult({ result, valid, flowDisplayName: flow.version.displayName }) }],
                    structuredContent: {
                        valid,
                        totalSteps: result.totalSteps,
                        validSteps: result.validSteps,
                        invalidSteps: result.invalidSteps,
                        skippedSteps: result.skippedSteps,
                        issues: errorIssues.map(i => ({ category: i.category, stepName: i.stepName, message: i.message })),
                        warnings: warningIssues.map(i => ({ category: i.category, stepName: i.stepName, message: i.message })),
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
                // A router is never fixed with ap_update_step — the usual cause is a non-fallback
                // branch carrying no conditions, which can never match and makes its children
                // unreachable (#429).
                const fixHint = step.type === FlowActionType.ROUTER
                    ? 'every non-fallback branch needs at least one condition — use ap_update_branch to configure it, or ap_delete_branch to drop it'
                    : 'use ap_update_step to fix'
                issues.push({ category: 'step_validity', stepName: step.name, message: `${mcpUtils.wrapUntrustedValue(step.displayName)} is invalid (${fixHint}).` })
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
                    issues.push({ category: 'template_reference', stepName: step.name, message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references "{{${ref}...}}" which does not exist in the flow.` })
                }
                else if (!seenSteps.has(ref)) {
                    issues.push({ category: 'template_reference', stepName: step.name, message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references "{{${ref}...}}" which comes AFTER it in execution order.` })
                }
            }
        }

        if (step.type === FlowActionType.LOOP_ON_ITEMS && !isNil(step.settings.collect)) {
            issues.push(...validateLoopCollectReferences({ loop: step, allStepNames, seenSteps }))
        }

        if (step.type === FlowActionType.ROUTER) {
            const { children, settings } = step
            // Recomputed rather than read off `step.valid`, because a router written before #429
            // was stored as valid and a LOCKED version is never re-validated. Without this, the
            // routers that silently changed which branch they take on upgrade — the whole affected
            // population — have no detection path at all.
            if (step.valid && !RouterActionSettingsWithValidation.safeParse(settings).success) {
                issues.push({ category: 'step_validity', stepName: step.name, message: `${mcpUtils.wrapUntrustedValue(step.displayName)} is stored as valid but no longer satisfies router validation. The usual cause is a non-fallback branch with no conditions: such a branch can never match, so its steps never run — inspect it with ap_flow_structure, then configure it with ap_update_branch or drop it with ap_delete_branch and republish.` })
            }
            const branches = settings.branches ?? []
            for (let i = 0; i < children.length; i++) {
                if (isNil(children[i])) {
                    // Only a set `branchName` is flow-authored; `Branch ${i}` is this tool's own
                    // fallback label for an unnamed branch and must not be wrapped as if it were
                    // untrusted data.
                    const branchName = branches[i]?.branchName
                    const branchLabel = branchName ? mcpUtils.wrapUntrustedValue(branchName) : `Branch ${i}`
                    issues.push({ category: 'empty_branch', stepName: step.name, message: `${mcpUtils.wrapUntrustedValue(step.displayName)} has empty branch: ${branchLabel}.` })
                }
            }
        }

        seenSteps.add(step.name)
    }

    return { totalSteps: allSteps.length, validSteps: validCount, invalidSteps: invalidCount, skippedSteps: skippedCount, issues }
}

// A step keeps the exact qadam version it was configured with. When an image upgrade drops that
// version and #424's bundled fallback cannot reach the replacement — a caret range does not cross a
// minor for a 0.x package, so a `0.3.1` pin never resolves to a bundled `0.4.5` — the flow stays
// LOCKED, valid and ENABLED and fails only when something next provisions it, with the cause
// visible in worker logs and nowhere a flow owner looks (#432).
async function validatePinnedQadamVersions({ trigger, platformId, log }: {
    trigger: Step
    platformId: string
    log: FastifyBaseLogger
}): Promise<ValidationIssue[]> {
    // No `skip` filter, unlike every other check here: `extractQadamPackages` in the worker
    // provisions every PIECE step in the version regardless of `skip`, so a dead pin on a skipped
    // step still fails provisioning on every trigger tick and every run. Excluding it would report
    // exactly the flow this category exists to catch as ready to publish.
    const qadamSteps = qadamPinUtil.getQadamSteps({ trigger })

    // Distinct (name, version) pairs only: a flow with twelve tables steps on one pin should cost
    // one resolution, not twelve, and the answer cannot differ between them.
    const pins = qadamPinUtil.collectDistinctPins({ steps: qadamSteps })
    const resolutions = await qadamPinUtil.resolvePins({ pins, platformId, log })

    return qadamSteps.flatMap((step) => {
        const pin = qadamPinUtil.pinOf({ step })
        // Shared with `ap_flow_structure` via `mcpUtils.qadamPinIssue`, so the two tools cannot
        // give an agent contradictory accounts of the same pin — a confirmed miss (`false`) gets
        // the assertive wording and the delete-and-re-add remedy; a lookup that merely errored
        // (`undefined`) must not (#474).
        const issue = mcpUtils.qadamPinIssue({ pin, resolvable: resolutions.get(pin) })
        if (isNil(issue)) {
            return []
        }
        return [{
            category: 'qadam_version' as const,
            stepName: step.name,
            message: `${mcpUtils.wrapUntrustedValue(step.displayName)} ${issue.message}`,
        }]
    })
}

// `ap_validate_flow` is the only pre-publish gate an automated flow builder has, and until now it
// could not see the two ways a `callFlow` step fails at run time while reading as configured: an
// empty argument set, and an inline child that pauses. Both are decidable statically — the payload
// is right there in the step, and the call graph is already stored on the server (#391).
async function validateCallFlowSteps({ trigger, projectId, platformId, log }: {
    trigger: Step
    projectId: string
    platformId: string
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
    const markers = await loadPauseMarkers({ graph, platformId, log })

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
            message: `${mcpUtils.wrapUntrustedValue(step.displayName)} calls a subflow with an empty payload, but that subflow declares arguments — the child will run with none. Set flowProps.payload with ap_update_step.`,
        }]
    })

    const inlineTargets = callFlowSteps.filter(step => readCallFlowInput(step).executionMode === INLINE_EXECUTION_MODE)
    const pauseIssues = inlineTargets.flatMap((step) => {
        const externalId = readCallFlowInput(step).externalId
        const pausingStep = isNil(externalId) ? null : findPausingFlow({ root: externalId, graph, markers })
        if (isNil(pausingStep)) {
            return []
        }
        return [{
            category: 'inline_pause' as const,
            stepName: step.name,
            message: `${mcpUtils.wrapUntrustedValue(step.displayName)} runs its subflow inline, but ${mcpUtils.wrapUntrustedValue(pausingStep.flowName)} pauses at ${mcpUtils.wrapUntrustedValue(pausingStep.stepDisplayName)} (${pausingStep.reason}). An inline child has no queue job to resume from — switch this step to Queue execution mode.`,
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

// Reads what the walk needs from a flow: its qadam steps (judged for pausing once the markers are
// loaded), and which flows it runs inline. A Queue-mode child runs as a separate job and is not
// an edge here — it only matters because waiting on one is itself a pause, which `readPauseReason`
// reports.
function readFlowNode(flow: { version: { displayName: string, trigger: Step } }): FlowNode {
    const steps = flowStructureUtil.getAllSteps(flow.version.trigger)
        .filter(step => !('skip' in step && step.skip === true))
    const expectsArguments = !isEmptyPayload(readCallableFlowSampleData(flow.version.trigger))
    const qadamSteps = steps.filter(isQadamStep)
    const inlineChildren = qadamSteps.flatMap((step) => {
        if (!isCallFlowStep(step) || readCallFlowInput(step).executionMode !== INLINE_EXECUTION_MODE) {
            return []
        }
        const childExternalId = readCallFlowInput(step).externalId
        return isNil(childExternalId) ? [] : [childExternalId]
    })
    // A durable loop checkpoints by pausing the run (#387), which an inline child cannot do.
    const durableLoops = steps
        .filter((step): step is LoopOnItemsAction => step.type === FlowActionType.LOOP_ON_ITEMS && step.settings.execution?.durable === true)
        .map(loop => loop.displayName)
    return { flowName: flow.version.displayName, qadamSteps, inlineChildren, expectsArguments, durableLoops }
}

// An iteration of a CONCURRENT loop cannot pause (#387): the engine refuses the step at run time,
// before any waitpoint exists. This reports the same thing before publish, reading the same
// `pauses` markers the inline check reads. The run-time refusal stays the authority — a
// 'conditional' action this check cannot evaluate is reported as "may pause".
async function validateConcurrentLoops({ trigger, flowName, platformId, log }: {
    trigger: Step
    flowName: string
    platformId: string
    log: FastifyBaseLogger
}): Promise<ValidationIssue[]> {
    const bodies = flowStructureUtil.getAllSteps(trigger)
        .filter((step): step is LoopOnItemsAction => step.type === FlowActionType.LOOP_ON_ITEMS && step.settings.execution?.mode === LoopExecutionMode.CONCURRENT)
        .flatMap(loop => isNil(loop.firstLoopAction) ? [] : [{
            loop,
            qadamSteps: flowStructureUtil.getAllSteps(loop.firstLoopAction)
                .filter(step => !('skip' in step && step.skip === true))
                .filter((step): step is QadamStep => step.type === FlowActionType.PIECE),
        }])
    if (bodies.length === 0) {
        return []
    }
    const graph = new Map<string, FlowNode>(bodies.map(({ loop, qadamSteps }) => [loop.name, { flowName, expectsArguments: false, qadamSteps, inlineChildren: [], durableLoops: [] }]))
    const markers = await loadPauseMarkers({ graph, platformId, log })
    // A step inside nested CONCURRENT loops is in both bodies; it is reported once, under the outer.
    const reported = new Set<string>()
    return bodies.flatMap(({ loop, qadamSteps }) => qadamSteps.flatMap((step): ValidationIssue[] => {
        const reason = readPauseReason({ step, metadata: markers.get(qadamPinUtil.pinOf({ step })) })
        if (isNil(reason) || reported.has(step.name)) {
            return []
        }
        reported.add(step.name)
        return [{
            category: 'concurrent_pause',
            stepName: step.name,
            message: `${mcpUtils.wrapUntrustedValue(step.displayName)} is inside the CONCURRENT loop ${mcpUtils.wrapUntrustedValue(loop.displayName)} but pauses (${reason}). An iteration of a CONCURRENT loop cannot pause — set the loop's execution mode to SEQUENTIAL, or move the step out of the loop.`,
        }]
    }))
}

// Whether an action pauses is declared by the action itself (`pauses` on `createAction`, #426),
// so the answer lives in the pinned version's metadata. One lookup per distinct pin across the
// whole graph: a flow with twelve steps on one pin costs one resolution. A lookup that fails —
// the pin no longer resolves (already reported under `qadam_version`), the DB errored — yields no
// metadata, and the step is judged the way pins predating the marker are, by the frozen table.
async function loadPauseMarkers({ graph, platformId, log }: {
    graph: Map<string, FlowNode>
    platformId: string
    log: FastifyBaseLogger
}): Promise<Map<string, QadamMetadataModel | undefined>> {
    const steps = [...graph.values()].flatMap(node => node.qadamSteps)
    const pins = qadamPinUtil.collectDistinctPins({ steps })
    const entries = await Promise.all(pins.map(async (pin): Promise<[string, QadamMetadataModel | undefined]> => {
        const { name, version } = qadamPinUtil.splitPin({ pin })
        const { data, error } = await tryCatch(() => qadamMetadataService(log).get({ name, version, platformId }))
        if (!isNil(error)) {
            log.warn({ err: error, pin }, 'ap_validate_flow: qadam metadata lookup failed while reading pause markers')
        }
        return [pin, data ?? undefined]
    }))
    return new Map(entries)
}

function findPausingStepIn({ node, markers }: { node: FlowNode, markers: PauseMarkers }): PausingStep | null {
    const durableLoop = node.durableLoops[0]
    if (!isNil(durableLoop)) {
        return { flowName: node.flowName, stepDisplayName: durableLoop, reason: 'a durable loop, which pauses the run to checkpoint when it runs out of time' }
    }
    return node.qadamSteps.reduce<PausingStep | null>((found, step) => {
        if (!isNil(found)) {
            return found
        }
        const reason = readPauseReason({ step, metadata: markers.get(qadamPinUtil.pinOf({ step })) })
        return isNil(reason)
            ? null
            : { flowName: node.flowName, stepDisplayName: step.displayName, reason }
    }, null)
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

function findPausingFlow({ root, graph, markers }: { root: string, graph: Map<string, FlowNode>, markers: PauseMarkers }): PausingStep | null {
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
        const pausingStep = findPausingStepIn({ node, markers })
        if (!isNil(pausingStep)) {
            return pausingStep
        }
        pending.push(...node.inlineChildren)
    }
    return null
}

// The action's own `pauses` marker decides (#426). `true` pauses; `'conditional'` is handed to the
// evaluator for that action when this check has one, and reported as "may pause" when it does not
// — the policy `delayFor` set for an unknown duration, applied to an unknown action: a flow author
// is told about a possible run-time failure rather than shown a green report that lies. A pin
// whose metadata predates the marker (or could not be read) falls back to the frozen table.
function readPauseReason({ step, metadata }: { step: QadamStep, metadata: QadamMetadataModel | undefined }): string | null {
    const { qadamName, actionName } = step.settings
    const key = `${qadamName}:${actionName}`
    const action = isNil(actionName) ? undefined : metadata?.actions[actionName]
    const marker: PauseBehaviour | undefined = action?.pauses
    const evaluate = Object.hasOwn(CONDITIONAL_PAUSE_EVALUATORS, key) ? CONDITIONAL_PAUSE_EVALUATORS[key] : undefined

    if (marker === true) {
        return `${mcpUtils.wrapUntrustedValue(action?.displayName ?? actionName ?? '')}, which always pauses`
    }
    if (marker === 'conditional') {
        return isNil(evaluate)
            ? `${mcpUtils.wrapUntrustedValue(action?.displayName ?? actionName ?? '')}, which pauses depending on its configuration — this check cannot evaluate it, so it may pause`
            : evaluate(step)
    }
    if (Object.hasOwn(LEGACY_PAUSING_ACTIONS, key)) {
        return LEGACY_PAUSING_ACTIONS[key]
    }
    return isNil(evaluate) ? null : evaluate(step)
}

function readCallFlowPauseReason(step: QadamStep): string | null {
    const callFlowInput = readCallFlowInput(step)
    if (callFlowInput.executionMode === INLINE_EXECUTION_MODE) {
        return null
    }
    if (callFlowInput.waitForResponse === 'unknown') {
        return 'a Queue-mode Call Flow whose "wait for response" is not known until run time, so it may pause'
    }
    return callFlowInput.waitForResponse ? 'a Queue-mode Call Flow that waits for a response' : null
}

// `transcribe` only waits when the author asked it to wait; submitting and moving on is the
// default, and flagging that would be a false "cannot publish" on a flow that works.
function readTranscribePauseReason(step: QadamStep): string | null {
    const waitUntilReady = readCheckbox((step.settings.input ?? {}).wait_until_ready)
    if (waitUntilReady === 'unknown') {
        return 'an AssemblyAI transcription whose "wait until ready" is not known until run time, so it may pause'
    }
    return waitUntilReady ? 'an AssemblyAI transcription set to wait until it is ready' : null
}

// A Checkbox stores a boolean, or a string once the author switches it to dynamic mode
// (`z.union([z.boolean(), z.string()])`). The two spellings of a literal are read the same way
// here so the conditional cases cannot disagree with each other (#426); a template expression
// resolves only at run time and is reported as unknown rather than assumed safe.
function readCheckbox(value: unknown): boolean | 'unknown' {
    if (isNil(value) || value === '') {
        return false
    }
    if (typeof value === 'boolean') {
        return value
    }
    if (value === 'true' || value === 'false') {
        return value === 'true'
    }
    return 'unknown'
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
        waitForResponse: readCheckbox(input.waitForResponse),
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

// `collect.value` runs at the end of each iteration (#41), so unlike the loop's other settings it
// may read the loop's own body — steps that come after the loop in the flow's order.
function validateLoopCollectReferences({ loop, allStepNames, seenSteps }: { loop: LoopOnItemsAction, allStepNames: Set<string>, seenSteps: Set<string> }): ValidationIssue[] {
    const collectValue = loop.settings.collect?.value ?? ''
    const bodyStepNames = new Set(isNil(loop.firstLoopAction) ? [] : flowStructureUtil.getAllSteps(loop.firstLoopAction).map(s => s.name))
    return [...extractReferencedStepNames({ value: collectValue })].flatMap((ref): ValidationIssue[] => {
        if (!allStepNames.has(ref)) {
            return [{ category: 'template_reference', stepName: loop.name, message: `${mcpUtils.wrapUntrustedValue(loop.displayName)} collects "{{${ref}...}}" which does not exist in the flow.` }]
        }
        if (ref === loop.name || seenSteps.has(ref) || bodyStepNames.has(ref)) {
            return []
        }
        return [{ category: 'template_reference', stepName: loop.name, message: `${mcpUtils.wrapUntrustedValue(loop.displayName)} collects "{{${ref}...}}", which runs after the loop — collect can read steps inside the loop or before it.` }]
    })
}

// Static check: every `{{$t['key']}}` reference is checked against the project's translation
// table, using the exact same grammar the engine's `handleTranslation` accepts
// (`parseTranslationToken`, shared from `@aiqadam/shared`) — a token the engine would reject at
// run time (a trailing `.field`, an unterminated locale bracket) is never reported as a valid
// reference here, and vice versa. The bracket's own dynamic-locale expression (`$t['key'][expr]`)
// is never evaluated here — only the literal key is checked, and the message says so.
//
// Three severities, not two: a key referenced nowhere in the table is always an error (it fails
// every run, per `TranslationKeyNotFoundError`). A key that resolves against the project's own
// `defaultLocale` (base language included, mirroring the engine's own fallback) is also an error —
// with no explicit/dynamic locale and nothing the run inherits, the chain ends there, so this is
// the case that actually fails at run time for the common no-override configuration. A key that
// is merely missing a locale *other* keys in the project have is a warning: it may simply not have
// been translated yet, and unlike the other two it never fails the run by itself.
async function validateFlowTranslations({ trigger, localeSource, projectId, platformId, log }: {
    trigger: Step
    localeSource: string | null | undefined
    projectId: string
    platformId: string
    log: FastifyBaseLogger
}): Promise<ValidationIssue[]> {
    const localeSourceIssues = validateLocaleSourceItself({ localeSource })

    const steps = flowStructureUtil.getAllSteps(trigger).filter(step => !('skip' in step && step.skip === true))
    const refsByStep = steps.flatMap((step) => {
        const refs = collectStringValues({ step }).flatMap((value) => extractTranslationKeyRefs({ value }))
        return refs.map((ref) => ({ step, ...ref }))
    })
    if (refsByStep.length === 0) {
        return localeSourceIssues
    }

    const [table, project] = await Promise.all([
        translationService(log).list({
            projectId,
            platformId,
            cursor: undefined,
            limit: MAX_TRANSLATION_KEYS_PER_PROJECT,
            key: undefined,
        }),
        projectService(log).getOneOrThrow(projectId),
    ])
    const byKey = new Map(table.data.map((row) => [row.key, row]))
    const allLocales = unique(table.data.flatMap((row) => Object.keys(row.values)))
    const canonicalDefaultLocale = isNil(project.defaultLocale) ? null : localeUtil.canonicalize(project.defaultLocale)

    const seen = new Set<string>()
    const keyIssues = refsByStep.flatMap(({ step, key, hasDynamicLocale, malformed }): ValidationIssue[] => {
        const dedupeKey = `${step.name}:${key}`
        if (seen.has(dedupeKey)) {
            return []
        }
        seen.add(dedupeKey)
        const displayKey = TRANSLATION_KEY_REGEX.test(key) ? key : mcpUtils.wrapUntrustedValue(key)

        if (malformed) {
            return [{
                category: 'translation_key',
                stepName: step.name,
                message: `${mcpUtils.wrapUntrustedValue(step.displayName)} contains "$t[${displayKey}...]"-shaped text that is not a valid $t[...] reference (a trailing .field, an unterminated locale bracket, or similar) and will fail with an unresolved-reference error at run time — use ap_upsert_translations to check the key, or fix the reference.`,
            }]
        }

        const row = byKey.get(key)
        if (isNil(row)) {
            return [{
                category: 'translation_key',
                stepName: step.name,
                message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references translation key "${displayKey}" which does not exist — use ap_upsert_translations to create it.`,
            }]
        }

        // With no explicit locale bracket, this ref resolves purely off `localeUtil.buildCandidateChain`'s
        // run-locale/default-locale legs — if BOTH are unset, that chain is empty, `localeUtil.resolve`
        // never has a candidate to try, and the step fails at run time no matter what the table holds
        // for this key (even a row with every locale filled in cannot help: nothing selects one). This
        // is checked instead of (not in addition to) the "missing the default locale's value" check
        // below, since there is no default locale here to be missing a value for in the first place.
        const noLocaleChainAtAll = !hasDynamicLocale && isNil(localeSource) && isNil(canonicalDefaultLocale)
        const defaultLocaleIssue: ValidationIssue[] = noLocaleChainAtAll
            ? [{
                category: 'translation_default_locale',
                stepName: step.name,
                message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references translation key "${displayKey}" with no explicit locale, but this project has neither a default locale nor is this flow's localeSource set — there is nothing for the run to resolve a locale from, so this step will fail at run time regardless of which locales the key has values for. Set the project's default locale, set this flow's localeSource, or reference an explicit locale (e.g. $t['${key}']['en']).`,
            }]
            : (!isNil(canonicalDefaultLocale) && !keyHasValueForLocaleOrBase({ row, locale: canonicalDefaultLocale }))
                ? [{
                    category: 'translation_default_locale',
                    stepName: step.name,
                    message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references translation key "${displayKey}", which has no value for the project's default locale ("${canonicalDefaultLocale}") — a run with no explicit or inherited locale will fail this step.`,
                }]
                : []

        const missingLocales = allLocales.filter((locale) => locale !== canonicalDefaultLocale && row.values[locale] === undefined)
        const dynamicNote = hasDynamicLocale ? ' This step\'s locale is chosen dynamically at run time and is not statically checked.' : ''
        const localeWarning: ValidationIssue[] = missingLocales.length === 0 ? [] : [{
            category: 'translation_locale',
            stepName: step.name,
            severity: 'warning',
            message: `${mcpUtils.wrapUntrustedValue(step.displayName)} references translation key "${displayKey}", which has no value for locale(s): ${missingLocales.join(', ')}.${dynamicNote}`,
        }]

        return [...defaultLocaleIssue, ...localeWarning]
    })
    return [...localeSourceIssues, ...keyIssues]
}

// A `$t` nested inside `localeSource` cannot resolve to anything useful: the engine's own
// reentrancy guard (`EngineConstants#getRunLocale`) reports "no run locale yet" to it rather than
// hanging, which means the nested lookup always resolves against the project's default locale
// chain regardless of what the run's real locale would otherwise have been — never a crash, but
// never the flow author's intent either.
function validateLocaleSourceItself({ localeSource }: { localeSource: string | null | undefined }): ValidationIssue[] {
    if (isNil(localeSource)) {
        return []
    }
    const referencesTranslation = extractMustacheTokens(localeSource).some((token) => token.inner.trim().startsWith('$t'))
    if (!referencesTranslation) {
        return []
    }
    return [{
        category: 'translation_locale',
        stepName: 'localeSource',
        severity: 'warning',
        message: 'This flow\'s localeSource references a translation ($t[...]) — a $t nested inside localeSource cannot resolve the run\'s own locale (the engine reports "no run locale yet" to it instead of recursing), so it always falls back to the project\'s default locale chain. Use a plain step reference or literal instead.',
    }]
}

function keyHasValueForLocaleOrBase({ row, locale }: { row: { values: Record<string, string> }, locale: string }): boolean {
    if (row.values[locale] !== undefined) {
        return true
    }
    const base = localeUtil.baseLanguage(locale)
    return !isNil(base) && row.values[base] !== undefined
}

function extractTranslationKeyRefs({ value }: { value: string }): { key: string, hasDynamicLocale: boolean, malformed: boolean }[] {
    return extractMustacheTokens(value).flatMap((token): { key: string, hasDynamicLocale: boolean, malformed: boolean }[] => {
        const inner = token.inner.trim()
        if (!inner.startsWith('$t')) {
            return []
        }
        const parsed = parseTranslationToken(inner)
        if (isNil(parsed)) {
            // Not parseable at all as `$t[...]` — still worth a malformed-reference key, built
            // from whatever text follows `$t` so the message has something to point at, entirely
            // untrusted (never matches TRANSLATION_KEY_REGEX by construction, so it is always
            // wrapped before being echoed).
            return [{ key: inner.slice(2), hasDynamicLocale: false, malformed: true }]
        }
        return [{ key: parsed.key, hasDynamicLocale: !isNil(parsed.localeExpr), malformed: false }]
    })
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
        // `variables` belongs beside `connections`: both are context roots, not steps. Reporting
        // `{{variables['X']}}` as "references a step that does not exist" put a false positive on
        // the exact form the engine's unresolved-reference error tells the author to switch to.
        // `$t` (translations) is a third root, checked here defensively even though `\w+` can
        // never actually capture a name starting with `$` — future-proofing against this pattern
        // being loosened rather than a live gap today.
        if (name !== 'connections' && name !== 'variables' && name !== '$t') {
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
const UNRESOLVED_FLOW: FlowNode = { flowName: '', qadamSteps: [], inlineChildren: [], expectsArguments: false, durableLoops: [] }
const ASSEMBLYAI_QADAM = '@aiqadam/qadam-assemblyai'
const ASSEMBLYAI_TRANSCRIBE_ACTION = 'transcribe'
// FROZEN. Consulted only for a step pinned to a qadam version whose metadata carries no `pauses`
// marker — every version published before #426 — so the check does not regress for flows already
// built. Since #426 the fact lives on the action (`pauses` on `createAction`, enforced by
// `tools/ci/check-pause-markers.mjs`), and a new pausing action must declare it there, never be
// added here: a table entry covers exactly the versions that also carry the marker, so it would
// be dead on arrival. The two `request_action_*` rows are the correction of the #425 grep that
// built this list: both wait through `common/request-action.ts` rather than in their own files
// and were missed — precisely the miss #426 predicted.
const LEGACY_PAUSING_ACTIONS: Record<string, string> = {
    [`${DELAY_QADAM}:delay_until`]: 'a Delay Until',
    '@aiqadam/qadam-approval:wait_for_approval': 'a Wait for Approval',
    '@aiqadam/qadam-webhook:return_response_and_wait_for_next_webhook': 'a webhook wait',
    '@aiqadam/qadam-slack:request_approval_message': 'a Slack approval request',
    '@aiqadam/qadam-slack:request_approval_direct_message': 'a Slack approval request',
    '@aiqadam/qadam-slack:request_action_message': 'a Slack action request',
    '@aiqadam/qadam-slack:request_action_direct_message': 'a Slack action request',
    '@aiqadam/qadam-microsoft-teams:request_approval_direct_message': 'a Teams approval request',
    '@aiqadam/qadam-microsoft-teams:request_approval_in_channel': 'a Teams approval request',
    '@aiqadam/qadam-discord:request_approval_message': 'a Discord approval request',
    '@aiqadam/qadam-telegram-bot:request_approval_message': 'a Telegram approval request',
    '@aiqadam/qadam-gmail:request_approval_in_mail': 'a Gmail approval request',
    '@aiqadam/qadam-microsoft-outlook:request_approval_in_mail': 'an Outlook approval request',
}
// The `'conditional'` markers this check knows how to evaluate against the step's stored input.
// A `'conditional'` action absent from here is reported as "may pause" (see `readPauseReason`);
// the same three are also evaluated for pre-marker pins, where they were the conditional cases
// of the frozen table.
const CONDITIONAL_PAUSE_EVALUATORS: Record<string, (step: QadamStep) => string | null> = {
    [`${SUBFLOWS_QADAM}:${CALL_FLOW_ACTION}`]: readCallFlowPauseReason,
    [`${DELAY_QADAM}:${DELAY_FOR_ACTION}`]: readDelayForPauseReason,
    [`${ASSEMBLYAI_QADAM}:${ASSEMBLYAI_TRANSCRIBE_ACTION}`]: readTranscribePauseReason,
}

const CATEGORY_ORDER: ValidationIssue['category'][] = ['step_validity', 'qadam_version', 'template_reference', 'translation_key', 'translation_default_locale', 'translation_locale', 'empty_branch', 'subflow_payload', 'inline_pause', 'concurrent_pause']
const CATEGORY_LABELS: Record<ValidationIssue['category'], string> = {
    step_validity: 'Step Validity',
    qadam_version: 'Unavailable Qadam Versions',
    template_reference: 'Template References',
    translation_key: 'Unknown Translation Keys',
    translation_default_locale: 'Translations Missing The Default Locale',
    translation_locale: 'Translations Missing Locales',
    empty_branch: 'Empty Branches',
    subflow_payload: 'Subflow Payloads',
    inline_pause: 'Inline Subflows That Pause',
    concurrent_pause: 'Pausing Steps In Concurrent Loops',
}

// `valid` is the SAME boolean the tool's `structuredContent.valid` reports, computed once by the
// caller (`errorIssues.length === 0 && result.validSteps > 0`) and passed in rather than re-derived
// here from `result.issues` a second time — two independent computations of the same fact drift the
// moment one of them gains a case the other does not (this happened: a `$t` reference this project
// can never resolve produced no issue at all, so both formulas agreed on "valid" by both missing the
// same thing — but the fix belongs to `validateFlowTranslations` emitting the issue, not to keeping
// two formulas in sync forever after). Gating "ready to publish" on `valid` directly means a NEW
// issue category some future change forgets to filter into `errors` still prints the flow as invalid
// here, because there is only one source of truth to forget.
//
// A warning (`severity: 'warning'`) never blocks "ready to publish" and is never counted in
// "invalid" — it gets its own labeled section below the blocking issues instead, so it stays
// visible without being confused for something that will fail the run.
function formatValidationResult({ result, valid, flowDisplayName }: { result: ValidationResult, valid: boolean, flowDisplayName: string }): string {
    const errors = result.issues.filter((issue) => issue.severity !== 'warning')
    const warnings = result.issues.filter((issue) => issue.severity === 'warning')

    if (valid && warnings.length === 0) {
        const skippedNote = result.skippedSteps > 0 ? `, ${result.skippedSteps} skipped` : ''
        return `✅ Flow ${mcpUtils.wrapUntrustedValue(flowDisplayName)} is ready to publish (${result.totalSteps} steps, ${result.validSteps} valid${skippedNote}).`
    }

    if (!valid && errors.length === 0 && warnings.length === 0 && result.validSteps === 0) {
        return `⚠️ Flow ${mcpUtils.wrapUntrustedValue(flowDisplayName)} has no valid steps (${result.totalSteps} total). Configure the trigger and actions before publishing.`
    }

    const lines: string[] = []
    if (valid) {
        const skippedNote = result.skippedSteps > 0 ? `, ${result.skippedSteps} skipped` : ''
        lines.push(`✅ Flow ${mcpUtils.wrapUntrustedValue(flowDisplayName)} is ready to publish (${result.totalSteps} steps, ${result.validSteps} valid${skippedNote}), with ${warnings.length} warning(s):`)
    }
    else {
        lines.push(`⚠️ Flow ${mcpUtils.wrapUntrustedValue(flowDisplayName)} has ${errors.length} issue(s)${warnings.length > 0 ? ` and ${warnings.length} warning(s)` : ''}:`)
    }
    lines.push('')

    lines.push(...formatIssueGroups(errors))
    if (warnings.length > 0) {
        lines.push('Warnings (do not block publishing):')
        lines.push(...formatIssueGroups(warnings))
    }

    lines.push(`Summary: ${result.totalSteps} total, ${result.validSteps} valid, ${result.invalidSteps} invalid, ${result.skippedSteps} skipped`)

    return lines.join('\n')
}

function formatIssueGroups(issues: ValidationIssue[]): string[] {
    const grouped = new Map<ValidationIssue['category'], ValidationIssue[]>()
    for (const issue of issues) {
        const list = grouped.get(issue.category) ?? []
        list.push(issue)
        grouped.set(issue.category, list)
    }

    const lines: string[] = []
    for (const category of CATEGORY_ORDER) {
        const categoryIssues = grouped.get(category)
        if (categoryIssues && categoryIssues.length > 0) {
            lines.push(`${CATEGORY_LABELS[category]}:`)
            for (const issue of categoryIssues) lines.push(`- ${issue.stepName}: ${issue.message}`)
            lines.push('')
        }
    }
    return lines
}

type ValidationIssue = {
    category: 'step_validity' | 'qadam_version' | 'template_reference' | 'translation_key' | 'translation_locale' | 'translation_default_locale' | 'empty_branch' | 'subflow_payload' | 'inline_pause' | 'concurrent_pause'
    stepName: string
    message: string
    // Omitted (or 'error') blocks `structuredContent.valid` and counts toward "invalid" in the
    // summary; 'warning' is reported but never blocks. Only `translation_locale` (missing a
    // non-default locale, or a `$t` nested inside `localeSource`) is a warning today.
    // `translation_default_locale` (missing the project's own default locale) is deliberately an
    // error, not a warning — that is the one gap that fails a run with no explicit or inherited
    // locale, so it gets the same severity as every other category that fails the run outright.
    severity?: 'error' | 'warning'
}

type QadamStep = Extract<Step, { type: FlowActionType.PIECE }>

type CallFlowInput = {
    externalId: string | undefined
    payload: unknown
    executionMode: string | undefined
    waitForResponse: boolean | 'unknown'
}

type PauseMarkers = Map<string, QadamMetadataModel | undefined>

type PausingStep = {
    flowName: string
    stepDisplayName: string
    reason: string
}

type FlowNode = {
    flowName: string
    expectsArguments: boolean
    qadamSteps: QadamStep[]
    inlineChildren: string[]
    durableLoops: string[]
}

type ValidationResult = {
    totalSteps: number
    validSteps: number
    invalidSteps: number
    skippedSteps: number
    issues: ValidationIssue[]
}
