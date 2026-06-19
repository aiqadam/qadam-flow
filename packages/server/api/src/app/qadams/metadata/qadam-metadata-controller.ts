import { QadamMetadataModel, QadamMetadataModelSummary } from '@aiqadam/qadams-framework'
import {
    ALL_PRINCIPAL_TYPES,
    EngineResponse,
    ErrorCode,
    GetQadamRequestParams,
    GetQadamRequestQuery,
    GetQadamRequestWithScopeParams,
    isNil,
    ListQadamsRequestQuery,
    LocalesEnum,
    Principal,
    PrincipalType,
    QadamCategory,
    QadamFlowError,
    QadamOptionRequest,
    RegistryQadamsRequestQuery,
    SampleDataFileType,
    WorkerJobType,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { flowService } from '../../flows/flow/flow.service'
import { sampleDataService } from '../../flows/step-run/sample-data.service'
import { userInteractionWatcher } from '../../workers/user-interaction-watcher'
import { qadamSyncService } from '../qadam-sync-service'
import { getQadamPackageWithoutArchive, qadamMetadataService } from './qadam-metadata-service'

export const qadamModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(baseQadamsController, { prefix: '/v1/qadams' })
}

const baseQadamsController: FastifyPluginAsyncZod = async (app) => {

    app.get(
        '/categories',
        ListCategoriesRequest,
        async (): Promise<QadamCategory[]> => {
            return Object.values(QadamCategory)
        },
    )

    app.get('/', ListPiecesRequest, async (req): Promise<QadamMetadataModelSummary[]> => {
        const query = req.query

        const oldSyncCall = !isNil(query.release)
        if (oldSyncCall) {
            throw new QadamFlowError({
                code: ErrorCode.QADAM_SYNC_NOT_SUPPORTED,
                params: {
                    message: 'This endpoint is deprecated. Please use it without release parameter.',
                    release: query.release ?? '',
                },
            })
        }
        const includeTags = query.includeTags ?? false
        const platformId = getPlatformId(req.principal)
        const projectId = req.query.projectId
        const qadamMetadataSummary = await qadamMetadataService(req.log).list({
            includeHidden: query.includeHidden ?? false,
            projectId,
            platformId,
            includeTags,
            categories: query.categories,
            searchQuery: query.searchQuery,
            sortBy: query.sortBy,
            orderBy: query.orderBy,
            suggestionType: query.suggestionType,
            locale: query.locale as LocalesEnum | undefined,
        })
        return qadamMetadataSummary.map((qadam) => {
            return {
                ...qadam,
                i18n: undefined,
            }
        })
    })

    app.get(
        '/:scope/:name',
        GetPieceParamsWithScopeRequest,
        async (req) => {
            const { name, scope } = req.params
            const { version } = req.query

            const decodeScope = decodeURIComponent(scope)
            const decodedName = decodeURIComponent(name)
            const platformId = getPlatformId(req.principal)
            return qadamMetadataService(req.log).getOrThrow({
                platformId,
                name: `${decodeScope}/${decodedName}`,
                version,
                locale: req.query.locale as LocalesEnum | undefined,
            })
        },
    )

    app.get(
        '/:name',
        GetPieceParamsRequest,
        async (req): Promise<QadamMetadataModel> => {
            const { name } = req.params
            const { version } = req.query
            const decodedName = decodeURIComponent(name)
            const platformId = getPlatformId(req.principal)
            return qadamMetadataService(req.log).getOrThrow({
                platformId,
                name: decodedName,
                version,
                locale: req.query.locale as LocalesEnum | undefined,
            })
        },
    )

    app.get('/registry', RegistryPiecesRequest, async (req) => {
        const pieces = await qadamMetadataService(req.log).registry({
            release: req.query.release,
            platformId: getPlatformId(req.principal),
        })
        return pieces
    })

    app.post('/sync', SyncPiecesRequest, async (req) => qadamSyncService(req.log).sync({ publishCacheRefresh: true }))

    app.post(
        '/options',
        OptionsPieceRequest,
        async (req) => {
            const projectId = req.projectId
            const platform = req.principal.platform
            const flow = await flowService(req.log).getOnePopulatedOrThrow({
                projectId,
                id: req.body.flowId,
                versionId: req.body.flowVersionId,
            })
            const sampleData = await sampleDataService(req.log).getSampleDataForFlow(projectId, flow.version, SampleDataFileType.OUTPUT)
            const { response } = await userInteractionWatcher.submitAndWaitForResponse<EngineResponse<unknown>>({
                jobType: WorkerJobType.EXECUTE_PROPERTY,
                platformId: platform.id,
                projectId,
                flowVersion: flow.version,
                propertyName: req.body.propertyName,
                actionOrTriggerName: req.body.actionOrTriggerName,
                input: req.body.input,
                sampleData,
                searchValue: req.body.searchValue,
                qadam: await getQadamPackageWithoutArchive(req.log, platform.id, req.body),
            }, req.log)
            return response
        },
    )

}

function getPlatformId(principal: Principal): string | undefined {
    return principal.type === PrincipalType.WORKER || principal.type === PrincipalType.UNKNOWN || principal.type === PrincipalType.ONBOARDING ? undefined : principal.platform?.id
}

const RegistryPiecesRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        querystring: RegistryQadamsRequestQuery,
    },
}

const ListPiecesRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        querystring: ListQadamsRequestQuery,

    },

}
const GetPieceParamsRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: GetQadamRequestParams,
        querystring: GetQadamRequestQuery,
    },
}

const GetPieceParamsWithScopeRequest = {
    config: {
        security: securityAccess.unscoped(ALL_PRINCIPAL_TYPES),
    },
    schema: {
        params: GetQadamRequestWithScopeParams,
        querystring: GetQadamRequestQuery,
    },
}

const ListCategoriesRequest = {
    config: {
        security: securityAccess.public(),
    },
    schema: {
        querystring: ListQadamsRequestQuery,
    },
}

const OptionsPieceRequest = {
    schema: {
        body: QadamOptionRequest,
    },
    config: {
        security: securityAccess.project([PrincipalType.USER], undefined, {
            type: ProjectResourceType.BODY,
        }),
    },
}

const SyncPiecesRequest = {
    config: {
        security: securityAccess.publicPlatform([PrincipalType.USER]),
    },
}