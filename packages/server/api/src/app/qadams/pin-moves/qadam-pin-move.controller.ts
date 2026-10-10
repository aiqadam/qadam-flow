import { ApId, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { ListQadamPinMovesRequestQuery, QadamPinMove, QadamPinMovePage } from './qadam-pin-move.dto'
import { qadamPinMoveService } from './qadam-pin-move.service'

export const qadamPinMoveController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', ListQadamPinMovesRequest, async (req) => {
        return qadamPinMoveService(req.log).list({ platformId: req.principal.platform.id, query: req.query })
    })

    app.get('/:id', GetQadamPinMoveRequest, async (req) => {
        return qadamPinMoveService(req.log).getOneOrThrow({ id: req.params.id, platformId: req.principal.platform.id })
    })

    app.post('/:id/revert', RevertQadamPinMoveRequest, async (req) => {
        return qadamPinMoveService(req.log).revert({ id: req.params.id, platformId: req.principal.platform.id, userId: req.principal.id })
    })
}

// Platform admins only: a record names every project's flows on the platform, and a revert changes
// a flow in any of them. A project-level read and revert comes with the builder's "update this
// step" (#808, later slice).
const ListQadamPinMovesRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        tags: ['qadam-pin-moves'],
        querystring: ListQadamPinMovesRequestQuery,
        response: {
            [StatusCodes.OK]: QadamPinMovePage,
        },
    },
}

const GetQadamPinMoveRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        tags: ['qadam-pin-moves'],
        params: z.object({ id: ApId }),
        response: {
            [StatusCodes.OK]: QadamPinMove,
        },
    },
}

const RevertQadamPinMoveRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        tags: ['qadam-pin-moves'],
        params: z.object({ id: ApId }),
        response: {
            [StatusCodes.OK]: QadamPinMove,
        },
    },
}
