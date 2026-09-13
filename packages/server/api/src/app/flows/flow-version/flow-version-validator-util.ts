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
    FlowTriggerType,
    isNil,
    LoopOnItemsActionSettings,
    PlatformId,
    QadamActionSettings,
    QadamTriggerSettings,
    RouterActionSettingsWithValidation,
    SourceCode,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { qadamMetadataService } from '../../qadams/metadata/qadam-metadata-service'

const loopSettingsValidator = LoopOnItemsActionSettings.and(z.object({
    items: z.string().min(1),
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
    async prepareRequest({ platformId, request, userId }: PrepareRequestParams): Promise<FlowOperationRequest> {
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
                        const result = await validateAction(
                            { settings: clonedRequest.request.settings, platformId, log },
                        )
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
                        const result = await validateTrigger(
                            { settings: clonedRequest.request.settings, platformId, log },
                        )
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

async function validateAction({ settings, platformId, log }: ValidateActionParams): Promise<ValidationResult> {
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

async function validateTrigger({ settings, platformId, log }: ValidateTriggerParams): Promise<ValidationResult> {
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
        valid: propsSchema.safeParse(declaredInput).success,
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
}

type ValidateActionParams = {
    settings: QadamActionSettings
    platformId?: PlatformId
    log: FastifyBaseLogger
}

type ValidateTriggerParams = {
    settings: QadamTriggerSettings
    platformId?: PlatformId
    log: FastifyBaseLogger
}
