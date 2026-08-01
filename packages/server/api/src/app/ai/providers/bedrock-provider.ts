import { safeHttp } from '@aiqadam/server-utils'
import {
    AIProviderModel,
    AIProviderModelType,
    BedrockProviderAuthConfig,
    BedrockProviderConfig,
    INVALID_AWS_REGION_MESSAGE,
    isNil,
    isValidAwsRegion,
} from '@aiqadam/shared'

import {
    BedrockClient,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
    ModelModality,
} from '@aws-sdk/client-bedrock'

import { NodeHttpHandler } from '@smithy/node-http-handler'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const bedrockProvider: AIProviderStrategy<
BedrockProviderAuthConfig,
BedrockProviderConfig
> = {
    name: 'AWS Bedrock',

    async validateConnection(
        authConfig: BedrockProviderAuthConfig,
        config: BedrockProviderConfig,
        _log: FastifyBaseLogger,
    ): Promise<void> {
        await bedrockProvider.listModels(authConfig, config)
    },

    async listModels(
        authConfig: BedrockProviderAuthConfig,
        config: BedrockProviderConfig,
    ): Promise<AIProviderModel[]> {
        // `region` is interpolated into the endpoint by the SDK with no validation of its own:
        // `evil.com/` resolves to host `bedrock.evil.com`, `x@evil.com` to `evil.com.amazonaws.com`
        // (checked against the installed `@aws-sdk/client-bedrock`). The SigV4 `Authorization`
        // header — access key id plus signature — would go with it. `BedrockProviderConfig` now
        // refuses such a value, but this reads the row verbatim and never re-parses it, so a row
        // written before that constraint still needs stopping here. Same shape as Azure's
        // `resourceName` (#276).
        if (!isValidAwsRegion(config.region)) {
            throw new Error(INVALID_AWS_REGION_MESSAGE)
        }
        const client = new BedrockClient({
            region: config.region,
            credentials: {
                accessKeyId: authConfig.accessKeyId,
                secretAccessKey: authConfig.secretAccessKey,
            },
            // The AWS SDK takes neither an axios instance nor a `fetch` override, so it is the
            // one call in this directory that reaches the filter through the agents directly.
            // Without this it runs on the SDK's own unfiltered handler and is outside the SSRF
            // filter entirely, which is the other half of #276.
            requestHandler: new NodeHttpHandler(safeHttp.buildDefaultAgents()),
        })

        const [foundationResponse, profileByModelArn] = await Promise.all([
            client.send(new ListFoundationModelsCommand({})),
            listSystemInferenceProfiles(client),
        ])

        const summaries = foundationResponse.modelSummaries ?? []

        const models = summaries
            .filter(
                (m) => !!m.modelId && m.modelLifecycle?.status === 'ACTIVE',
            )
            .map((m) => {
                const outputs = m.outputModalities ?? []
                const isImage = outputs.includes(ModelModality.IMAGE)
                const isText = outputs.includes(ModelModality.TEXT)

                const foundationId = m.modelId as string
                const profileId = m.modelArn ? profileByModelArn.get(m.modelArn) : undefined
                const invocationId = profileId ?? foundationId
                const displayName = m.modelName ?? foundationId

                if (isImage) {
                    return {
                        id: invocationId,
                        name: displayName,
                        type: AIProviderModelType.IMAGE,
                    }
                }

                if (isText && m.responseStreamingSupported === true) {
                    return {
                        id: invocationId,
                        name: displayName,
                        type: AIProviderModelType.TEXT,
                    }
                }

                return null
            })
            .filter((m) => !isNil(m)) as AIProviderModel[]

        return models
    },
}

async function listSystemInferenceProfiles(client: BedrockClient): Promise<Map<string, string>> {
    const profileByModelArn = new Map<string, string>()
    try {
        const response = await client.send(new ListInferenceProfilesCommand({
            typeEquals: 'SYSTEM_DEFINED',
        }))
        for (const profile of response.inferenceProfileSummaries ?? []) {
            if (profile.status !== 'ACTIVE' || !profile.inferenceProfileId) continue
            for (const model of profile.models ?? []) {
                if (model.modelArn && !profileByModelArn.has(model.modelArn)) {
                    profileByModelArn.set(model.modelArn, profile.inferenceProfileId)
                }
            }
        }
    }
    catch {
        // Missing bedrock:ListInferenceProfiles permission falls through to foundation IDs.
    }
    return profileByModelArn
}
