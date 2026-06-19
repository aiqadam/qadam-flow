import { QadamPropertyMap, StaticPropsValue, TriggerStrategy } from '@aiqadam/qadams-framework'
import { assertEqual, AUTHENTICATION_PROPERTY_NAME, EngineGenericError, EventPayload, ExecuteTriggerResponse, FlowTrigger, InvalidCronExpressionError, isNil, PieceTrigger, PropertySettings, ScheduleOptions, TriggerHookType, TriggerSourceScheduleType } from '@aiqadam/shared'
import { isValidCron } from 'cron-validator'
import { EngineConstants, ResolvedExecuteTriggerOperation } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { createFileUploader } from '../qadam-context/file-uploader'
import { createFlowsContext } from '../qadam-context/flows'
import { createContextStore } from '../qadam-context/store'
import { utils } from '../utils'
import { propsProcessor } from '../variables/props-processor'
import { createPropsResolver } from '../variables/props-resolver'
import { qadamLoader } from './qadam-loader'

type Listener = {
    events: string[]
    identifierValue: string
    identifierKey: string
}

export const triggerHelper = {
    async executeOnStart(trigger: FlowTrigger, constants: EngineConstants, payload: unknown) {
        const { qadamName, qadamVersion, triggerName, input, propertySettings } = (trigger as PieceTrigger).settings

        if (isNil(triggerName)) {
            throw new EngineGenericError('TriggerNameNotSetError', 'Trigger name is not set')
        }

        const { qadamTrigger, processedInput, qadam } = await prepareTriggerExecution({
            qadamName,
            qadamVersion,
            triggerName,
            input,
            projectId: constants.projectId,
            apiUrl: constants.internalApiUrl,
            engineToken: constants.engineToken,
            devQadams: constants.devQadams,
            propertySettings,
            stepNames: constants.stepNames,
        })
        const isOldVersionOrNotSupported = isNil(qadamTrigger.onStart)
        if (isOldVersionOrNotSupported) {
            return
        }
        const context = {
            store: createContextStore({
                apiUrl: constants.internalApiUrl,
                prefix: '',
                flowId: constants.flowId,
                engineToken: constants.engineToken,
            }),
            auth: processedInput[AUTHENTICATION_PROPERTY_NAME],
            propsValue: processedInput,
            payload,
            run: {
                id: constants.flowRunId,
            },
            step: {
                name: triggerName,
            },
            project: {
                id: constants.projectId,
                externalId: constants.externalProjectId,
            },
            connections: utils.createConnectionManager({
                apiUrl: constants.internalApiUrl,
                projectId: constants.projectId,
                engineToken: constants.engineToken,
                target: 'triggers',
                contextVersion: qadam.getContextInfo?.().version,
            }),
        }
        await qadamTrigger.onStart(context)
    },

    async executeTrigger({ params, constants }: ExecuteTriggerParams): Promise<ExecuteTriggerResponse<TriggerHookType>> {
        const { qadamName, qadamVersion, triggerName, input, propertySettings } = (params.flowVersion.trigger as PieceTrigger).settings

        if (isNil(triggerName)) {
            throw new EngineGenericError('TriggerNameNotSetError', 'Trigger name is not set')
        }

        const { qadam, qadamTrigger, processedInput } = await prepareTriggerExecution({
            qadamName,
            qadamVersion,
            triggerName,
            input,
            projectId: params.projectId,
            apiUrl: constants.internalApiUrl,
            engineToken: params.engineToken,
            devQadams: constants.devQadams,
            propertySettings,
            stepNames: constants.stepNames,
        })

        const appListeners: Listener[] = []
        const prefix = params.test ? 'test' : ''
        let scheduleOptions: ScheduleOptions | undefined = undefined
        const context = {
            store: createContextStore({
                apiUrl: constants.internalApiUrl,
                prefix,
                flowId: params.flowVersion.flowId,
                engineToken: params.engineToken,
            }),
            step: {
                name: triggerName,
            },
            app: {
                createListeners({ events, identifierKey, identifierValue }: Listener): void {
                    appListeners.push({ events, identifierValue, identifierKey })
                },
            },
            setSchedule(request: ScheduleOptions) {
                if (!isValidCron(request.cronExpression)) {
                    throw new InvalidCronExpressionError(request.cronExpression)
                }
                scheduleOptions = {
                    type: TriggerSourceScheduleType.CRON_EXPRESSION,
                    cronExpression: request.cronExpression,
                    timezone: request.timezone ?? 'UTC',
                }
            },
            flows: createFlowsContext({
                engineToken: params.engineToken,
                internalApiUrl: constants.internalApiUrl,
                flowId: params.flowVersion.flowId,
                flowVersionId: params.flowVersion.id,
            }),
            webhookUrl: params.webhookUrl,
            auth: processedInput[AUTHENTICATION_PROPERTY_NAME],
            propsValue: processedInput,
            payload: params.triggerPayload ?? {},
            project: {
                id: params.projectId,
                externalId: constants.externalProjectId,
            },
            server: {
                token: params.engineToken,
                apiUrl: constants.internalApiUrl,
                publicUrl: params.publicApiUrl,
            },
            connections: utils.createConnectionManager({
                apiUrl: constants.internalApiUrl,
                projectId: constants.projectId,
                engineToken: constants.engineToken,
                target: 'triggers',
                contextVersion: qadam.getContextInfo?.().version,
            }),
        }
        switch (params.hookType) {
            case TriggerHookType.ON_DISABLE: {
                await qadamTrigger.onDisable(context)
                return {}
            }
            case TriggerHookType.ON_ENABLE: {
                await qadamTrigger.onEnable(context)
                return {
                    listeners: appListeners,
                    scheduleOptions: qadamTrigger.type === TriggerStrategy.POLLING ? scheduleOptions : undefined,
                }
            }
            case TriggerHookType.RENEW: {
                assertEqual(qadamTrigger.type, TriggerStrategy.WEBHOOK, 'triggerType', 'WEBHOOK')
                await qadamTrigger.onRenew(context)
                return {}
            }
            case TriggerHookType.HANDSHAKE: {
                const { data: handshakeResponse, error: handshakeResponseError } = await utils.tryCatchAndThrowOnEngineError(() => qadamTrigger.onHandshake(context))

                if (handshakeResponseError) {
                    throw handshakeResponseError
                }
                return {
                    response: handshakeResponse,
                }
            }
            case TriggerHookType.TEST: {
                const { data: testResponse, error: testResponseError } = await utils.tryCatchAndThrowOnEngineError(() => qadamTrigger.test({
                    ...context,
                    files: createFileUploader({
                        apiUrl: constants.internalApiUrl,
                        engineToken: params.engineToken!,
                    }),
                }))

                if (testResponseError) {
                    throw testResponseError
                }
                return {
                    output: testResponse,
                }
            }
            case TriggerHookType.RUN: {
                if (qadamTrigger.type === TriggerStrategy.APP_WEBHOOK) {

                    const { data: verified, error: verifiedError } = await utils.tryCatchAndThrowOnEngineError(async () => {
                        if (!params.appWebhookUrl) {
                            throw new EngineGenericError('AppWebhookUrlNotAvailableError', `App webhook url is not available for piece name ${qadamName}`)
                        }
                        if (!params.webhookSecret) {
                            throw new EngineGenericError('WebhookSecretNotAvailableError', `Webhook secret is not available for piece name ${qadamName}`)
                        }

                        return qadam.events?.verify({
                            appWebhookUrl: params.appWebhookUrl,
                            payload: params.triggerPayload as EventPayload,
                            webhookSecret: params.webhookSecret,
                        })
                    })

                    if (verifiedError) {
                        throw verifiedError
                    }
                    if (isNil(verified)) {
                        throw new Error('Webhook is not verified')
                    }
                }

                const { data: triggerRunResult, error: triggerRunError } = await utils.tryCatchAndThrowOnEngineError(async () => {
                    const items = await qadamTrigger.run({
                        ...context,
                        files: createFileUploader({
                            apiUrl: constants.internalApiUrl,
                            engineToken: params.engineToken!,
                        }),
                    })
                    return {
                        output: items,
                    }
                })

                if (triggerRunError) {
                    throw triggerRunError
                }
                return triggerRunResult
            }
        }
    },
}

type ExecuteTriggerParams = {
    params: ResolvedExecuteTriggerOperation<TriggerHookType>
    constants: EngineConstants
}

async function prepareTriggerExecution({ qadamName, qadamVersion, triggerName, input, propertySettings, projectId, apiUrl, engineToken, devQadams, stepNames }: PrepareTriggerExecutionParams) {
    const { qadam, qadamTrigger } = await qadamLoader.getQadamAndTriggerOrThrow({
        qadamName,
        qadamVersion,
        triggerName,
        devQadams,
    })

    const { resolvedInput } = await createPropsResolver({
        apiUrl,
        projectId,
        engineToken,
        contextVersion: qadam.getContextInfo?.().version,
        stepNames,
    }).resolve<StaticPropsValue<QadamPropertyMap>>({
        unresolvedInput: input,
        executionState: FlowExecutorContext.empty(),
    })

    const { processedInput, errors } = await propsProcessor.applyProcessorsAndValidators(resolvedInput, qadamTrigger.props, qadam.auth, qadamTrigger.requireAuth, propertySettings)

    if (Object.keys(errors).length > 0) {
        throw new Error(JSON.stringify(errors, null, 2))
    }

    return { qadam, qadamTrigger, processedInput }
}

type PrepareTriggerExecutionParams = {
    qadamName: string
    qadamVersion: string
    triggerName: string
    input: unknown
    propertySettings: Record<string, PropertySettings>
    projectId: string
    apiUrl: string
    engineToken: string
    devQadams: string[]
    stepNames: string[]
}
