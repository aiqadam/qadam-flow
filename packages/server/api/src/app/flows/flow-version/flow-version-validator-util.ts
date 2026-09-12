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
                        warnOnUndeclaredKeys({ log, settings: clonedRequest.request.action.settings, result })
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
                        warnOnUndeclaredKeys({ log, settings: clonedRequest.request.settings, result })
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

function warnOnUndeclaredKeys({ log, settings, result }: {
    log: FastifyBaseLogger
    settings: QadamActionSettings
    result: ValidationResult
}): void {
    if (result.undeclaredKeys.length === 0) {
        return
    }
    log.warn({
        qadamName: settings.qadamName,
        qadamVersion: settings.qadamVersion,
        actionName: settings.actionName,
        undeclaredKeys: result.undeclaredKeys,
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
// value was simply gone (#381). Preserving it costs only that a prop removed by a later qadam
// version lingers unused in `input`; the engine ignores undeclared keys
// (`props-processor.ts` skips any key with no matching property).
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
