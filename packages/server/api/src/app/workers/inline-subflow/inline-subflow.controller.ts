import { ErrorCode, QadamFlowError } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { InlineSubflowParams } from './common'
import { inlineSubflowService } from './inline-subflow.service'

const InlineSubflowRequestBodySchema = z.object({
    flowId: z.string(),
    payload: z.unknown(),
    parentRunId: z.string().optional(),
    failParentOnFailure: z.boolean().optional(),
    versionId: z.string().optional(),
    callbackUrl: z.string().optional(),
    inlineDepth: z.number().int().min(0).optional(),
})

export const inlineSubflowController: FastifyPluginAsyncZod = async (app) => {
    app.post('/run-inline', {
        config: {
            security: securityAccess.engine(),
        },
        schema: {
            body: InlineSubflowRequestBodySchema,
        },
    }, async (request) => {
        const params: InlineSubflowParams = {
            flowId: request.body.flowId,
            payload: request.body.payload,
            parentRunId: request.body.parentRunId,
            failParentOnFailure: request.body.failParentOnFailure,
            versionId: request.body.versionId,
            callbackUrl: request.body.callbackUrl,
            inlineDepth: request.body.inlineDepth ?? 0,
        }

        const result = await inlineSubflowService(app.log).executeInline(params)

        if (!result.ok) {
            throw new QadamFlowError({
                code: ErrorCode.INTERNAL_SERVER_ERROR,
                params: {
                    message: result.error,
                },
            })
        }

        return result.data!
    })
}
