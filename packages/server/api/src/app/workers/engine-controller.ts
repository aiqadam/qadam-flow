
import { FlowVersion, GetFlowVersionForWorkerRequest, ListFlowsRequest, OptionalArrayFromQuery } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { entitiesMustBeOwnedByCurrentProject } from '../authentication/authorization'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { flowService } from '../flows/flow/flow.service'
import { flowVersionService } from '../flows/flow-version/flow-version.service'

export const flowEngineWorker: FastifyPluginAsyncZod = async (app) => {

    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)

    app.get('/populated-flows', GetAllFlowsByProjectParams, async (request) => {
        return flowService(request.log).list({
            projectIds: [request.principal.projectId],
            limit: request.query.limit ?? 1000000,
            cursorRequest: request.query.cursor ?? null,
            folderId: request.query.folderId,
            status: request.query.status,
            name: request.query.name,
            versionState: request.query.versionState,
            connectionExternalIds: request.query.connectionExternalIds,
            agentExternalIds: request.query.agentExternalIds,
            externalIds: request.query.externalIds,
            externalIdsOrIds: request.query.externalIdsOrIds,
        })
    })

    app.get('/flows', GetLockedVersionRequest, async (request) => {
        const flowVersion = await flowVersionService(request.log).getOneOrThrow(request.query.versionId)
        await flowService(request.log).getOneOrThrow({
            id: flowVersion.flowId,
            projectId: request.principal.projectId,
        })
        return flowVersion
    })

}


// Engine-only, deliberately not on the public `ListFlowsRequest`: it resolves a stored flow
// reference that may hold either an `externalId` or a primary-key `id`. `externalIds` keeps its
// exact-field meaning for every other caller.
const EngineListFlowsRequest = ListFlowsRequest.omit({ projectId: true }).extend({
    externalIdsOrIds: OptionalArrayFromQuery(z.string()),
})

const GetAllFlowsByProjectParams = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        querystring: EngineListFlowsRequest,
    },
}

const GetLockedVersionRequest = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        querystring: GetFlowVersionForWorkerRequest,
        response: {
            [StatusCodes.OK]: FlowVersion,
        },
    },
}