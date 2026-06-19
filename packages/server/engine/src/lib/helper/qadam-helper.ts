import path from 'path'
import {
    DropdownProperty,
    DynamicProperties,
    ExecutePropsResult,
    getAuthPropertyForValue,
    MultiSelectDropdownProperty,
    PropertyType,
    QadamAuthProperty,
    QadamMetadata,
    QadamPropertyMap,
    qadamTranslation,
    StaticPropsValue } from '@aiqadam/qadams-framework'
import {
    AppConnectionType,
    AppConnectionValue,
    EngineGenericError,
    ExecuteExtractQadamMetadata,
    ExecutePropsOptions,
    ExecuteValidateAuthOperation,
    ExecuteValidateAuthResponse,
    isNil,
} from '@aiqadam/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import { testExecutionContext } from '../handler/context/test-execution-context'
import { createFlowsContext } from '../qadam-context/flows'
import { utils } from '../utils'
import { createPropsResolver } from '../variables/props-resolver'
import { qadamLoader } from './qadam-loader'

export const qadamHelper = {
    async executeProps( operation: ExecutePropsParams): Promise<ExecutePropsResult<PropertyType.DROPDOWN | PropertyType.MULTI_SELECT_DROPDOWN | PropertyType.DYNAMIC>> {
        const constants = EngineConstants.fromExecutePropertyInput(operation)
        const executionState = await testExecutionContext.stateFromFlowVersion({
            apiUrl: operation.internalApiUrl,
            flowVersion: operation.flowVersion,
            projectId: operation.projectId,
            engineToken: operation.engineToken,
            sampleData: operation.sampleData,
            engineConstants: constants,
        })
        const { property, qadam } = await qadamLoader.getPropOrThrow({ qadamName: operation.qadamName, qadamVersion: operation.qadamVersion, actionOrTriggerName: operation.actionOrTriggerName, propertyName: operation.propertyName, devQadams: EngineConstants.DEV_QADAMS })

        if (property.type !== PropertyType.DROPDOWN && property.type !== PropertyType.MULTI_SELECT_DROPDOWN && property.type !== PropertyType.DYNAMIC) {
            throw new EngineGenericError('PropertyTypeNotExecutableError', `Property type is not executable: ${property.type} for ${property.displayName}`)
        }
        const { data: executePropsResult, error: executePropsError } = await utils.tryCatchAndThrowOnEngineError((async (): Promise<ExecutePropsResult<PropertyType.DROPDOWN | PropertyType.MULTI_SELECT_DROPDOWN | PropertyType.DYNAMIC>> => {
            const { resolvedInput } = await createPropsResolver({
                apiUrl: constants.internalApiUrl,
                projectId: constants.projectId,
                engineToken: constants.engineToken,
                contextVersion: qadam.getContextInfo?.().version,
                stepNames: constants.stepNames,
            }).resolve<
            StaticPropsValue<QadamPropertyMap>
            >({
                unresolvedInput: operation.input,
                executionState,
            })
            const ctx = {
                searchValue: operation.searchValue,
                server: {
                    token: constants.engineToken,
                    apiUrl: constants.internalApiUrl,
                    publicUrl: operation.publicApiUrl,
                },
                project: {
                    id: constants.projectId,
                    externalId: constants.externalProjectId,
                },
                flows: createFlowsContext(constants),
                step: {
                    name: operation.actionOrTriggerName,
                },
                connections: utils.createConnectionManager({
                    projectId: constants.projectId,
                    engineToken: constants.engineToken,
                    apiUrl: constants.internalApiUrl,
                    target: 'properties',
                    contextVersion: qadam.getContextInfo?.().version,
                }),
            }
          
            switch (property.type) {
                case PropertyType.DYNAMIC: {
                    const dynamicProperty = property as DynamicProperties<boolean>
                    const props = await dynamicProperty.props(resolvedInput, ctx)
                    return {
                        type: PropertyType.DYNAMIC,
                        options: props,
                    }
                }
                case PropertyType.MULTI_SELECT_DROPDOWN: {
                    const multiSelectProperty = property as MultiSelectDropdownProperty<
                    unknown,
                    boolean
                    >
                    const options = await multiSelectProperty.options(resolvedInput, ctx)
                    return {
                        type: PropertyType.MULTI_SELECT_DROPDOWN,
                        options,
                    }
                }
                case PropertyType.DROPDOWN: {
                    const dropdownProperty = property as DropdownProperty<unknown, boolean>
                    const options = await dropdownProperty.options(resolvedInput, ctx)
                    return {
                        type: PropertyType.DROPDOWN,
                        options,
                    }
                }
                default: {
                    throw new EngineGenericError('PropertyTypeNotExecutableError', `Property type is not executable: ${property}`)
                }
            }
        }))
        
        if (executePropsError) {
            console.error(executePropsError)
            return {
                type: property.type,
                options: {
                    disabled: true,
                    options: [],
                    placeholder: 'Throws an error, reconnect or refresh the page',
                },
            }
        }

        return executePropsResult
    },

    async executeValidateAuth(
        { params, devQadams }: { params: ExecuteValidateAuthOperation, devQadams: string[] },
    ): Promise<ExecuteValidateAuthResponse> {
        const { qadam: qadamPackage } = params

        const piece = await qadamLoader.loadQadamOrThrow({ qadamName: qadamPackage.qadamName, qadamVersion: qadamPackage.qadamVersion, devQadams })
        const server = {
            apiUrl: params.internalApiUrl.endsWith('/') ? params.internalApiUrl : params.internalApiUrl + '/',
            publicUrl: params.publicApiUrl,
        }
        return  validateAuth({
            authValue: params.auth,
            qadamAuth: piece.auth,
            server,
        })

    },

    async extractQadamMetadata({ devQadams, params }: { devQadams: string[], params: ExecuteExtractQadamMetadata }): Promise<QadamMetadata> {
        const { qadamName, qadamVersion } = params
        const piece = await qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams })
        const qadamAlias = qadamLoader.getPackageAlias({ qadamName, qadamVersion, devQadams })
        const qadamIndexPath = await qadamLoader.getQadamPath({ packageName: qadamAlias, devQadams })
        const qadamDistRoot = path.dirname(path.dirname(qadamIndexPath))
        const i18n = await qadamTranslation.initializeI18n(qadamDistRoot)
        const fullMetadata = piece.metadata()
        return {
            ...fullMetadata,
            name: qadamName,
            version: qadamVersion,
            authors: piece.authors,
            i18n,
        }
    },
}

type ExecutePropsParams = Omit<ExecutePropsOptions, 'qadam'> & { qadamName: string, qadamVersion: string }


function mismatchAuthTypeErrorMessage(qadamAuthType: PropertyType, connectionType: AppConnectionType): ExecuteValidateAuthResponse {
    return {
        valid: false,
        error: `Connection value type does not match piece auth type: ${qadamAuthType} !== ${connectionType}`,
    }
}

const validateAuth = async ({
    server,
    authValue,
    qadamAuth,
}: ValidateAuthParams): Promise<ExecuteValidateAuthResponse> => {
    if (isNil(qadamAuth)) {
        return {
            valid: true,
        }
    }
    const usedQadamAuth = getAuthPropertyForValue({
        authValueType: authValue.type,
        qadamAuth,
    })

    if (isNil(usedQadamAuth)) {
        return {
            valid: false,
            error: 'No piece auth found for auth value',
        }
    }
    if (isNil(usedQadamAuth.validate)) {
        return {
            valid: true,
        }
    }
  

    switch (usedQadamAuth.type) {
        case PropertyType.OAUTH2:{
            if (authValue.type !== AppConnectionType.OAUTH2 && authValue.type !== AppConnectionType.PLATFORM_OAUTH2) {
                return mismatchAuthTypeErrorMessage(usedQadamAuth.type, authValue.type)
            }
            return usedQadamAuth.validate({
                auth: authValue,
                server,
            })
        }
        case PropertyType.BASIC_AUTH:{
            if (authValue.type !== AppConnectionType.BASIC_AUTH) {
                return mismatchAuthTypeErrorMessage(usedQadamAuth.type, authValue.type)
            }
            return usedQadamAuth.validate({
                auth: authValue,
                server,
            })
        }
        case PropertyType.SECRET_TEXT:{
            if (authValue.type !== AppConnectionType.SECRET_TEXT) {
                return mismatchAuthTypeErrorMessage(usedQadamAuth.type, authValue.type)
            }
            return usedQadamAuth.validate({
                auth: authValue.secret_text,
                server,
            })
        }
        case PropertyType.CUSTOM_AUTH:{
            if (authValue.type !== AppConnectionType.CUSTOM_AUTH) {
                return mismatchAuthTypeErrorMessage(usedQadamAuth.type, authValue.type)
            }
            return usedQadamAuth.validate({
                auth: authValue.props,
                server,
            })
        }
        default: {
            throw new EngineGenericError('InvalidAuthTypeError', 'Invalid auth type')
        }
    }
}

type ValidateAuthParams = {
    server: {
        apiUrl: string
        publicUrl: string
    }
    authValue: AppConnectionValue
    qadamAuth: QadamAuthProperty | QadamAuthProperty[] | undefined
}