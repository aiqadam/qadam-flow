import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import { AddQadamRequestBody, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { qadamInstallService } from './qadam-install-service'

export const communityQadamsModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(communityQadamsController, { prefix: '/v1/qadams' })
}

const communityQadamsController: FastifyPluginAsyncZod = async (app) => {
    app.post(
        '/',
        {
            config: {
                security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
            },
            schema: {
                body: AddQadamRequestBody,
            },
        },
        async (req, res): Promise<QadamMetadataModel> => {
            const platformId = req.principal.platform.id
            const qadamMetadata = await qadamInstallService(req.log).installQadam(
                platformId,
                req.body,
            )
            return res.code(StatusCodes.CREATED).send(qadamMetadata)
        },
    )
}
