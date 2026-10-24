import {
    piecePropertiesUtils,
    QadamAuthProperty,
    QadamPropertyMap,
} from '@aiqadam/qadams-framework'
import {
    CodeActionSettings,
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
    flowQadamUtil,
    flowStructureUtil,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    isNil,
    LoopOnItemsActionSettings,
    MAX_AGENT_TOOL_PINS,
    PlatformId,
    QadamActionSettings,
    QadamTriggerSettings,
    RouterActionSettingsWithValidation,
    SourceCode,
    Step,
    tryCatch,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'

const loopSettingsValidator = LoopOnItemsActionSettings.and(z.object({
    items: z.string().min(1),
    // A collector with nothing to collect is a half-configured step, not "collect nothing" (#41).
    collect: z.object({ value: z.string().min(1) }).optional(),
}))
const routerSettingsValidator = RouterActionSettingsWithValidation
const MAX_LOGGED_UNDECLARED_KEYS = 20
const codeSettingsValidator = CodeActionSettings.and(z.object({
    sourceCode: SourceCode.and(z.object({
        code: z.string().min(1),
        packageJson: z.string().min(1),
    })),
}))

type ValidationResult = {
    valid: boolean
    cleanInput?: Record<string, unknown>
    undeclaredKeys: string[]
}

export const flowVersionValidationUtil = (log: FastifyBaseLogger) => ({
    async prepareRequest({ platformId, request, userId, storedFlowVersion }: PrepareRequestParams): Promise<FlowOperationRequest> {
        const clonedRequest: FlowOperationRequest = JSON.parse(JSON.stringify(request))

        switch (clonedRequest.type) {
            case FlowOperationType.ADD_ACTION:
                switch (clonedRequest.request.action.type) {
                    case FlowActionType.LOOP_ON_ITEMS:
                        clonedRequest.request.action.valid = loopSettingsValidator.safeParse(
                            clonedRequest.request.action.settings,
                        ).success
                        break
                    case FlowActionType.PIECE: {
                        clonedRequest.request.action.settings.qadamVersion = flowQadamUtil.getExactVersion(clonedRequest.request.action.settings.qadamVersion)
                        const result = await validateAction(
                            { settings: clonedRequest.request.action.settings, platformId, log },
                        )
                        clonedRequest.request.action.valid = result.valid
                        if (!isNil(result.cleanInput)) {
                            clonedRequest.request.action.settings.input = result.cleanInput
                        }
                        warnOnUndeclaredKeys({ log, qadamName: clonedRequest.request.action.settings.qadamName, qadamVersion: clonedRequest.request.action.settings.qadamVersion, component: clonedRequest.request.action.settings.actionName, result })
                        break
                    }
                    case FlowActionType.ROUTER:
                        clonedRequest.request.action.valid = routerSettingsValidator.safeParse(
                            clonedRequest.request.action.settings,
                        ).success
                        break
                    case FlowActionType.CODE:
                        clonedRequest.request.action.valid = codeSettingsValidator.safeParse(
                            clonedRequest.request.action.settings,
                        ).success
                        break
                }
                break
            case FlowOperationType.UPDATE_ACTION:
                switch (clonedRequest.request.type) {
                    case FlowActionType.LOOP_ON_ITEMS:
                        clonedRequest.request.valid = loopSettingsValidator.safeParse(
                            clonedRequest.request.settings,
                        ).success
                        break
                    case FlowActionType.PIECE: {
                        clonedRequest.request.settings.qadamVersion = flowQadamUtil.getExactVersion(clonedRequest.request.settings.qadamVersion)
                        const result = await validateAction({
                            settings: clonedRequest.request.settings,
                            platformId,
                            log,
                            fallbackToInstalledVersion: isStoredPinUnchanged({
                                storedStep: isNil(storedFlowVersion) ? undefined : flowStructureUtil.getStep(clonedRequest.request.name, storedFlowVersion.trigger),
                                expectedType: FlowActionType.PIECE,
                                qadamName: clonedRequest.request.settings.qadamName,
                                qadamVersion: clonedRequest.request.settings.qadamVersion,
                            }),
                        })
                        clonedRequest.request.valid = result.valid
                        if (!isNil(result.cleanInput)) {
                            clonedRequest.request.settings.input = result.cleanInput
                        }
                        warnOnUndeclaredKeys({ log, qadamName: clonedRequest.request.settings.qadamName, qadamVersion: clonedRequest.request.settings.qadamVersion, component: clonedRequest.request.settings.actionName, result })
                        break
                    }
                    case FlowActionType.ROUTER:
                        clonedRequest.request.valid = routerSettingsValidator.safeParse(
                            clonedRequest.request.settings,
                        ).success
                        break
                    case FlowActionType.CODE:
                        clonedRequest.request.valid = codeSettingsValidator.safeParse(
                            clonedRequest.request.settings,
                        ).success
                        break
                }
                break
            case FlowOperationType.UPDATE_TRIGGER:
                switch (clonedRequest.request.type) {
                    case FlowTriggerType.EMPTY:
                        clonedRequest.request.valid = false
                        break
                    case FlowTriggerType.PIECE: {
                        clonedRequest.request.settings.qadamVersion = flowQadamUtil.getExactVersion(clonedRequest.request.settings.qadamVersion)
                        const result = await validateTrigger({
                            settings: clonedRequest.request.settings,
                            platformId,
                            log,
                            fallbackToInstalledVersion: isStoredPinUnchanged({
                                storedStep: storedFlowVersion?.trigger,
                                expectedType: FlowTriggerType.PIECE,
                                qadamName: clonedRequest.request.settings.qadamName,
                                qadamVersion: clonedRequest.request.settings.qadamVersion,
                            }),
                        })
                        clonedRequest.request.valid = result.valid
                        if (result.valid && result.cleanInput) {
                            clonedRequest.request.settings.input = result.cleanInput
                        }
                        warnOnUndeclaredKeys({ log, qadamName: clonedRequest.request.settings.qadamName, qadamVersion: clonedRequest.request.settings.qadamVersion, component: clonedRequest.request.settings.triggerName, result })
                        break
                    }
                }
                break
            case FlowOperationType.IMPORT_FLOW:{
                const notes = clonedRequest.request.notes
                if (!isNil(notes)) {
                    clonedRequest.request.notes = notes.map(note => ({
                        ...note,
                        ownerId: userId,
                    }))
                }
                await normalizeAndValidateImportedPieceSteps({ trigger: clonedRequest.request.trigger, platformId, log })
                break
            }
            default:
                break
        }
        return clonedRequest
    },
})

// The key list is caller-sized, so it is capped before it reaches the log: a step carrying
// thousands of undeclared keys would otherwise turn every write into a proportional burst of log
// volume. Only names are logged, never values.
function warnOnUndeclaredKeys({ log, qadamName, qadamVersion, component, result }: {
    log: FastifyBaseLogger
    qadamName: string
    qadamVersion: string
    component: string | undefined
    result: ValidationResult
}): void {
    if (result.undeclaredKeys.length === 0) {
        return
    }
    log.warn({
        qadamName,
        qadamVersion,
        component,
        undeclaredKeyCount: result.undeclaredKeys.length,
        undeclaredKeys: result.undeclaredKeys.slice(0, MAX_LOGGED_UNDECLARED_KEYS),
    }, 'Step input carries keys the resolved qadam metadata does not declare; keeping them rather than erasing the caller\'s write')
}

// `_importFlow`'s sub-operations recurse back through `flowOperations.apply`, which already
// normalises a ranged pin (`~0.4.0`, MCP's default, `mcp-utils.ts`) for ADD_ACTION/UPDATE_TRIGGER
// regardless of whether they were dispatched directly or generated by an import — the
// `getExactVersion` call below is belt-and-braces with that, not a gap on its own. What IMPORT_FLOW
// skips, and those sub-operations have no way to do (they only re-parse the step's shape
// structurally — `add-action.ts`'s `createAction`, `update-trigger.ts`'s `createTrigger`), is
// asking `qadamMetadataService` whether a *resolvable* pin's input still satisfies the piece's
// current props — a caller can claim `valid: true` over input that fails that check, the way
// ADD_ACTION/UPDATE_TRIGGER already prevent.
//
// A pin that does not resolve at all is a different concern and must NOT be forced to
// `valid: false` here, for two reasons. First, correctness: ADR-0003 is explicit that an
// unavailable version is advisory ("the step is marked 'version unavailable — update this
// step'... and the flow is never disabled") and `flow-unavailable-qadam-pin.test.ts` (#808) asserts
// a publish with such a pin still succeeds — forcing `valid: false` here would route that same case
// through the *existing*, unrelated `!step.valid` publish gate (`flow.service.ts`) and block it
// anyway, just by a different door. Second, mechanics: IMPORT_FLOW is also this codebase's internal
// "copy a flow's own stored version" primitive (`createNewDraftIfVersionIsPublished` on every edit
// of a published flow, `USE_AS_DRAFT`, an `app-connection` reconnect, `ap_duplicate_flow`), so even
// a transient lookup failure here must not flip an already-valid, already-published step to
// invalid. When the pin does not resolve, the step's incoming `valid` and `input` are left exactly
// as the caller supplied them — the #843 stopgap below, and the pin-move/heal machinery, are what
// handle an unresolvable pin from here.
async function normalizeAndValidateImportedPieceSteps({ trigger, platformId, log }: {
    trigger: FlowTrigger
    platformId: PlatformId | undefined
    log: FastifyBaseLogger
}): Promise<void> {
    const steps = flowStructureUtil.getAllSteps(trigger)
    await Promise.all(steps.map(async (step) => {
        if (step.type === FlowTriggerType.PIECE) {
            step.settings.qadamVersion = flowQadamUtil.getExactVersion(step.settings.qadamVersion)
            const result = await resolveImportedPieceValidity({ validate: () => validateTrigger({ settings: step.settings, platformId, log }), log, qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion })
            if (isNil(result)) {
                return
            }
            step.valid = result.valid
            if (!isNil(result.cleanInput)) {
                step.settings.input = result.cleanInput
            }
            warnOnUndeclaredKeys({ log, qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion, component: step.settings.triggerName, result })
            return
        }
        if (step.type === FlowActionType.PIECE) {
            step.settings.qadamVersion = flowQadamUtil.getExactVersion(step.settings.qadamVersion)
            const result = await resolveImportedPieceValidity({ validate: () => validateAction({ settings: step.settings, platformId, log }), log, qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion })
            if (isNil(result)) {
                return
            }
            step.valid = result.valid
            if (!isNil(result.cleanInput)) {
                step.settings.input = result.cleanInput
            }
            warnOnUndeclaredKeys({ log, qadamName: step.settings.qadamName, qadamVersion: step.settings.qadamVersion, component: step.settings.actionName, result })
        }
    }))
}

// `validateAction`/`validateTrigger` call `qadamMetadataService().getOrThrow`, which throws when
// the pin does not resolve — the right behaviour for a direct ADD_ACTION/UPDATE_ACTION/UPDATE_TRIGGER,
// where the caller is naming that pin right now and should be told it failed. On import, that throw
// (an unresolvable pin, or a transient metadata-lookup error — both reach here the same way) means
// "nothing to recompute", not "invalid": returning `undefined` tells the caller to leave the step's
// `valid`/`input` exactly as supplied.
async function resolveImportedPieceValidity({ validate, log, qadamName, qadamVersion }: {
    validate: () => Promise<ValidationResult>
    log: FastifyBaseLogger
    qadamName: string
    qadamVersion: string
}): Promise<ValidationResult | undefined> {
    const { data, error } = await tryCatch(validate)
    if (!isNil(error)) {
        log.warn({ err: error, qadamName, qadamVersion }, '[flowVersionValidationUtil] could not resolve an imported step\'s qadam pin; keeping its reported validity and input unchanged rather than invalidating it')
        return undefined
    }
    return data ?? undefined
}

// STOPGAP for #843, to be removed when #808 gives an unavailable pin its proper handling (ADR-0003:
// the checked, audited fallback and the "update this step" state).
//
// A step whose pinned qadam version this instance cannot resolve can still be edited: the edit is
// validated against the installed version instead of being refused. That is allowed ONLY when the
// edit keeps the step's stored pin, on a stored step of the kind the operation updates (an
// UPDATE_ACTION that names the trigger would otherwise replace it with an action). A request that
// carries a different pin — a new step, or an update that repoints one — stays strict, because
// validating it against "whatever is installed" would store a pin nothing can resolve, which is the
// population #808 exists to clear. The pin itself is never rewritten here.
function isStoredPinUnchanged({ storedStep, expectedType, qadamName, qadamVersion }: IsStoredPinUnchangedParams): boolean {
    if (isNil(storedStep) || storedStep.type !== expectedType) {
        return false
    }
    if (storedStep.type !== FlowActionType.PIECE && storedStep.type !== FlowTriggerType.PIECE) {
        return false
    }
    const { qadamName: storedName, qadamVersion: storedVersion } = storedStep.settings
    // A legacy stored step can lack a version; there is no pin to keep, so it takes the strict path.
    if (isNil(storedVersion)) {
        return false
    }
    return storedName === qadamName
        && flowQadamUtil.getExactVersion(storedVersion) === flowQadamUtil.getExactVersion(qadamVersion)
}

async function validateAction({ settings, platformId, log, fallbackToInstalledVersion = false }: ValidateActionParams): Promise<ValidationResult> {
    if (
        isNil(settings.qadamName) ||
        isNil(settings.qadamVersion) ||
        isNil(settings.actionName) ||
        isNil(settings.input)
    ) {
        return { valid: false, undeclaredKeys: [] }
    }

    const piece = await qadamMetadataService(log).getOrThrow({
        platformId,
        name: settings.qadamName,
        version: settings.qadamVersion,
        fallbackToInstalledVersion,
    })

    if (isNil(piece)) {
        return { valid: false, undeclaredKeys: [] }
    }

    const action = piece.actions[settings.actionName]
    if (isNil(action)) {
        return { valid: false, undeclaredKeys: [] }
    }

    const props = { ...action.props }

    return validateProps(props, settings.input, piece.auth, action.requireAuth)
}

async function validateTrigger({ settings, platformId, log, fallbackToInstalledVersion = false }: ValidateTriggerParams): Promise<ValidationResult> {
    if (
        isNil(settings.qadamName) ||
        isNil(settings.qadamVersion) ||
        isNil(settings.triggerName) ||
        isNil(settings.input)
    ) {
        return { valid: false, undeclaredKeys: [] }
    }

    const piece = await qadamMetadataService(log).getOrThrow({
        platformId,
        name: settings.qadamName,
        version: settings.qadamVersion,
        fallbackToInstalledVersion,
    })
    if (isNil(piece)) {
        return { valid: false, undeclaredKeys: [] }
    }
    const trigger = piece.triggers[settings.triggerName]
    if (isNil(trigger)) {
        return { valid: false, undeclaredKeys: [] }
    }
    const props = { ...trigger.props }

    return validateProps(props, settings.input, piece.auth, trigger.requireAuth)
}

// The declared-prop projection is what decides `valid`, but it is NOT what gets stored: an input
// key the resolved metadata does not declare is kept verbatim. Dropping it silently erased a
// caller's own write whenever the step's pinned qadam version resolved to metadata older than the
// value being written — the write returned success, the step was marked `valid: true`, and the
// value was simply gone (#381).
//
// What preserving them costs, stated precisely: `props-processor.ts` copies the whole resolved
// input (`{ ...resolvedInput }`) and only skips undeclared keys for *processing*, so they do reach
// the qadam's `propsValue` unprocessed, and a handful of qadams spread `propsValue` straight into
// an outbound request body. This is not a new capability — `IMPORT_FLOW` expands into
// sub-operations inside `flowOperations.apply`, i.e. after `prepareRequest`, so undeclared keys
// were always storable and always reached `propsValue` by that route. The projection filtered one
// entrance and not the other; this makes it consistent rather than opening anything.
// See the `warnOnUndeclaredKeys` log for the operator-visible signal.
function validateProps(
    props: QadamPropertyMap,
    input: Record<string, unknown> | undefined,
    auth: QadamAuthProperty | QadamAuthProperty[] | undefined,
    //if require auth is not defined, we default to true, because at first all auth was required
    requireAuth: boolean | undefined = true,
): ValidationResult {
    const propsSchema = piecePropertiesUtils.buildSchema(props, auth, requireAuth)
    const schemaKeys = Object.keys((propsSchema as z.ZodObject<z.ZodRawShape>).shape)
    if (isNil(input)) {
        return { valid: propsSchema.safeParse(undefined).success, undeclaredKeys: [] }
    }
    const declaredInput = Object.fromEntries(schemaKeys.map(key => [key, input[key]]))
    const undeclaredKeys = Object.keys(input).filter(key => !schemaKeys.includes(key))
    return {
        // `countAgentToolPins` inspects `input.agentTools` on any PIECE step, declared or not: an
        // undeclared key is preserved below, and the worker reads it anyway, so gating on the
        // declaration would leave a way around the cap. It counts entries, because a repeated
        // entry is still walked at run time. This is a step-invalidity, not a write refusal: the
        // input is still stored, and the publish gate refuses the invalid step (#879).
        valid: flowQadamUtil.countAgentToolPins({ input }) <= MAX_AGENT_TOOL_PINS
            && propsSchema.safeParse(declaredInput).success,
        cleanInput: {
            ...declaredInput,
            ...Object.fromEntries(undeclaredKeys.map(key => [key, input[key]])),
        },
        undeclaredKeys,
    }
}

type PrepareRequestParams = {
    platformId?: PlatformId
    request: FlowOperationRequest
    userId: UserId | null
    // The version as stored before this operation. Only UPDATE_ACTION / UPDATE_TRIGGER read it, to
    // tell an edit that keeps a step's pin from one that sets a new pin (see `isStoredPinUnchanged`).
    storedFlowVersion?: FlowVersion
}

type IsStoredPinUnchangedParams = {
    storedStep: Step | undefined
    expectedType: FlowActionType.PIECE | FlowTriggerType.PIECE
    qadamName: string
    qadamVersion: string
}

type ValidateActionParams = {
    settings: QadamActionSettings
    platformId?: PlatformId
    log: FastifyBaseLogger
    fallbackToInstalledVersion?: boolean
}

type ValidateTriggerParams = {
    settings: QadamTriggerSettings
    platformId?: PlatformId
    log: FastifyBaseLogger
    fallbackToInstalledVersion?: boolean
}
