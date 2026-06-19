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

async function validateAction({ settings, platformId, log }: ValidateActionParams): Promise<ValidationResult> {
    if (
        isNil(settings.qadamName) ||
        isNil(settings.qadamVersion) ||
        isNil(settings.actionName) ||
        isNil(settings.input)
    ) {
        return { valid: false }
    }

    const piece = await qadamMetadataService(log).getOrThrow({
        platformId,
        name: settings.qadamName,
        version: settings.qadamVersion,
    })

    if (isNil(piece)) {
        return { valid: false }
    }

    const action = piece.actions[settings.actionName]
    if (isNil(action)) {
        return { valid: false }
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
        return { valid: false }
    }

    const piece = await qadamMetadataService(log).getOrThrow({
        platformId,
        name: settings.qadamName,
        version: settings.qadamVersion,
    })
    if (isNil(piece)) {
        return { valid: false }
    }
    const trigger = piece.triggers[settings.triggerName]
    if (isNil(trigger)) {
        return { valid: false }
    }
    const props = { ...trigger.props }

    return validateProps(props, settings.input, piece.auth, trigger.requireAuth)
}

function validateProps(
    props: QadamPropertyMap,
    input: Record<string, unknown> | undefined,
    auth: QadamAuthProperty | QadamAuthProperty[] | undefined,
    //if require auth is not defined, we default to true, because at first all auth was required
    requireAuth: boolean | undefined = true,
): ValidationResult {
    const propsSchema = piecePropertiesUtils.buildSchema(props, auth, requireAuth)
    const schemaKeys = Object.keys((propsSchema as z.ZodObject<z.ZodRawShape>).shape)
    const cleanInput = !isNil(input) ? Object.fromEntries(
        schemaKeys.map(key => [key, input?.[key]]),
    ) : undefined
    return {
        valid: propsSchema.safeParse(cleanInput).success,
        cleanInput,
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
