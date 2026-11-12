import { ApId, Permission, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { entitiesMustBeOwnedByCurrentProject } from '../../authentication/authorization'
import { EntitySourceType, ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { FlowEntity } from '../../flows/flow/flow.entity'
import { CheckQadamPinStaysRequestQuery, ListHeldQadamPinMovesRequestQuery, ListQadamPinMovesRequestQuery, QadamPinMove, QadamPinMovePage, QadamPinStayCheck, RevertedQadamPinMove } from './qadam-pin-move.dto'
import { qadamPinMoveService } from './qadam-pin-move.service'

export const qadamPinMoveController: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)
    app.get('/', ListQadamPinMovesRequest, async (req) => {
        return qadamPinMoveService({ log: req.log }).list({ platformId: req.principal.platform.id, query: req.query })
    })

    // The builder's read of the hold (#855, ADR-0004 "Following `main`"), project scoped. `/held` is
    // a static segment of the same collection — the records whose status is `REVERTED` for one flow
    // — so it outranks `/:id` and can never be read as a record id.
    app.get('/held', ListHeldQadamPinMovesRequest, async (req) => {
        return qadamPinMoveService({ log: req.log }).listHeld({
            flowId: req.query.flowId,
            projectId: req.projectId,
            platformId: req.principal.platform.id,
        })
    })

    // The builder's, MCP's and runs' project-scoped read of "version unavailable — update this
    // step" (ADR-0003) for one flow version. `/check` is a static segment of the same collection,
    // so it outranks `/:id` and can never be read as a record id, the same as `/held`.
    app.get('/check', CheckQadamPinStaysRequest, async (req): Promise<QadamPinStayCheck> => {
        return {
            pinStays: await qadamPinMoveService({ log: req.log }).checkUnavailablePins({
                flowId: req.query.flowId,
                flowVersionId: req.query.flowVersionId,
                projectId: req.projectId,
                platformId: req.principal.platform.id,
            }),
        }
    })

    app.get('/:id', GetQadamPinMoveRequest, async (req) => {
        return qadamPinMoveService({ log: req.log }).getOneOrThrow({ id: req.params.id, platformId: req.principal.platform.id })
    })

    app.post('/:id/revert', RevertQadamPinMoveRequest, async (req) => {
        return qadamPinMoveService({ log: req.log }).revert({ id: req.params.id, platformId: req.principal.platform.id, userId: req.principal.id })
    })
}

// Platform admins only: a record names every project's flows on the platform, and a revert changes
// a flow in any of them. The project-level read lives at `GET /held` below; a project-level revert
// still comes with the builder's "update this step" (#808, later slice).
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
            [StatusCodes.OK]: RevertedQadamPinMove,
        },
    },
}

// Shared by `/held` and `/check`: both marks are a property of the flow version, so any member of
// the flow's project with read access can read them, not only a platform admin. The flow entity
// resolves the project from `flowId` in the query, and the service asserts the flow (and, for
// `/check`, the version) belongs to that project, so another project's flow is neither resolved nor
// read.
const flowProjectReadSecurity = securityAccess.project(
    [PrincipalType.USER, PrincipalType.SERVICE],
    Permission.READ_FLOW,
    {
        type: ProjectResourceType.TABLE,
        tableName: FlowEntity,
        entitySourceType: EntitySourceType.QUERY,
        lookup: {
            paramKey: 'flowId',
            entityField: 'id',
        },
    })

const ListHeldQadamPinMovesRequest = {
    config: {
        security: flowProjectReadSecurity,
    },
    schema: {
        tags: ['qadam-pin-moves'],
        querystring: ListHeldQadamPinMovesRequestQuery,
        response: {
            [StatusCodes.OK]: QadamPinMovePage,
        },
    },
}

const CheckQadamPinStaysRequest = {
    config: {
        security: flowProjectReadSecurity,
    },
    schema: {
        tags: ['qadam-pin-moves'],
        querystring: CheckQadamPinStaysRequestQuery,
        response: {
            [StatusCodes.OK]: QadamPinStayCheck,
        },
    },
}
