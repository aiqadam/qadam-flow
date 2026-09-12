import {
    CreateRecordsRequest,
    DeleteRecordsRequest,
    GetRecordRequest,
    ListRecordsRequest,
    partition,
    Permission,
    PopulatedRecord,
    PrincipalType,
    SeekPage,
    SERVICE_KEY_SECURITY_OPENAPI,
    UpdateRecordRequest,
    UpdateRecordsRequest,
    UpsertAction,
    UpsertRecordsRequest,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { entitiesMustBeOwnedByCurrentProject } from '../../authentication/authorization'
import { EntitySourceType, ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { TableEntity } from '../table/table.entity'
import { recordSideEffects } from './record-side-effects'
import { RecordEntity } from './record.entity'
import { recordService } from './record.service'

const DEFAULT_PAGE_SIZE = 10

export const recordController: FastifyPluginAsyncZod = async (fastify) => {
    fastify.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)

    fastify.post('/', CreateRequest, async (request, reply) => {
        const records = await recordService.create({
            request: request.body,
            projectId: request.projectId,
            logger: request.log,
        })
        await reply.status(StatusCodes.CREATED).send(records)
        await recordSideEffects(fastify.log).handleRecordsEvent({
            tableId: request.body.tableId,
            projectId: request.projectId,
            records,
            logger: request.log,
            authorization: request.headers.authorization as string,
        }, 'created')
    })

    fastify.get('/:id', GetRecordByIdRequest, async (request) => {
        return recordService.getById({
            id: request.params.id,
            projectId: request.projectId,
            fieldIds: request.query.fieldIds,
        })
    })

    // A new route rather than an extension of an existing one: `POST /v1/records` is
    // pinned to 201 + a created-records array by the web client, the qadam and the MCP
    // tool, and `POST /v1/records/:id` has no id to address a batch with. Static
    // segments outrank parametric ones in find-my-way, and an apId() is 21 chars, so
    // no record id can ever be the literal "batch".
    fastify.post('/batch', BatchUpdateRequest, async (request, reply) => {
        const records = await recordService.updateMany({
            request: request.body,
            projectId: request.projectId,
        })
        await reply.status(StatusCodes.OK).send(records)
        await recordSideEffects(fastify.log).handleRecordsEvent({
            tableId: request.body.tableId,
            projectId: request.projectId,
            records,
            logger: request.log,
            authorization: request.headers.authorization as string,
            agentUpdate: request.body.agentUpdate ?? false,
        }, 'updated')
    })

    fastify.post('/upsert', UpsertRequest, async (request, reply) => {
        const results = await recordService.upsert({
            request: request.body,
            projectId: request.projectId,
        })
        await reply.status(StatusCodes.OK).send(results)

        // Split by outcome so RECORD_CREATED and RECORD_UPDATED webhooks each fire
        // for the rows they actually describe.
        const [created, updated] = partition(results, (result) => result.action === UpsertAction.CREATED)
        for (const [records, event] of [[created, 'created'], [updated, 'updated']] as const) {
            await recordSideEffects(fastify.log).handleRecordsEvent({
                tableId: request.body.tableId,
                projectId: request.projectId,
                records: records.map((result) => result.record),
                logger: request.log,
                authorization: request.headers.authorization as string,
            }, event)
        }
    })

    fastify.post('/:id', UpdateRequest, async (request, reply) => {
        const record = await recordService.update({
            id: request.params.id,
            request: request.body,
            projectId: request.projectId,
        })
        await reply.status(StatusCodes.OK).send(record)
        await recordSideEffects(fastify.log).handleRecordsEvent({
            tableId: request.body.tableId,
            projectId: request.projectId,
            records: [record],
            logger: request.log,
            authorization: request.headers.authorization as string,
            agentUpdate: request.body.agentUpdate ?? false,
        }, 'updated')
    })

    fastify.delete('/', DeleteRecordRequest, async (request, reply) => {
        const deletedRecords = await recordService.delete({
            ids: request.body.ids,
            projectId: request.projectId,
        })
        await reply.status(StatusCodes.OK).send([])
        await recordSideEffects(fastify.log).handleRecordsEvent({
            tableId: deletedRecords[0]?.tableId,
            projectId: request.projectId,
            records: deletedRecords,
            logger: request.log,
            authorization: request.headers.authorization as string,
        }, 'deleted')
    })

    fastify.get('/', ListRequest, async (request) => {
        return recordService.list({
            tableId: request.query.tableId,
            projectId: request.projectId,
            cursorRequest: request.query.cursor ?? null,
            limit: request.query.limit ?? request.query.recordIds?.length ?? DEFAULT_PAGE_SIZE,
            filters: request.query.filters ?? null,
            fieldIds: request.query.fieldIds,
            recordIds: request.query.recordIds,
        })
    })
}

const CreateRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.WRITE_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: TableEntity,
            entitySourceType: EntitySourceType.BODY,
            lookup: {
                paramKey: 'tableId',
                entityField: 'id',
            },
        }),
    },
    schema: {
        body: CreateRecordsRequest,
        response: {
            [StatusCodes.CREATED]: z.array(PopulatedRecord),
        },
    },
}

const GetRecordByIdRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.READ_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: RecordEntity,
        }),
    },
    schema: {
        params: z.object({
            id: z.string(),
        }),
        querystring: GetRecordRequest,
        response: {
            [StatusCodes.OK]: PopulatedRecord,
            [StatusCodes.NOT_FOUND]: z.string(),
        },
    },
}

const UpsertRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.WRITE_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: TableEntity,
            entitySourceType: EntitySourceType.BODY,
            lookup: {
                paramKey: 'tableId',
                entityField: 'id',
            },
        }),
    },
    schema: {
        tags: ['records'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Insert or update records matched on a key',
        body: UpsertRecordsRequest,
        response: {
            [StatusCodes.OK]: z.array(z.object({
                action: z.enum(UpsertAction),
                record: PopulatedRecord,
            })),
        },
    },
}

const BatchUpdateRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.WRITE_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: TableEntity,
            entitySourceType: EntitySourceType.BODY,
            lookup: {
                paramKey: 'tableId',
                entityField: 'id',
            },
        }),
    },
    schema: {
        tags: ['records'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Update many records in one request',
        body: UpdateRecordsRequest,
        response: {
            [StatusCodes.OK]: z.array(PopulatedRecord),
        },
    },
}

const UpdateRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.WRITE_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: RecordEntity,
        }),
    },
    schema: {
        tags: ['records'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Update a record',
        params: z.object({
            id: z.string(),
        }),
        body: UpdateRecordRequest,
        response: {
            [StatusCodes.OK]: PopulatedRecord,
        },

    },
}

const DeleteRecordRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.WRITE_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: TableEntity,
            entitySourceType: EntitySourceType.BODY,
            lookup: {
                paramKey: 'tableId',
                entityField: 'id',
            },
        }),
    },
    schema: {
        tags: ['records'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Delete records',
        body: DeleteRecordsRequest,
        response: {
            [StatusCodes.OK]: z.array(PopulatedRecord),
        },
    },
}

const ListRequest = {
    config: {
        security: securityAccess.project([PrincipalType.USER, PrincipalType.ENGINE, PrincipalType.SERVICE], Permission.READ_TABLE, {
            type: ProjectResourceType.TABLE,
            tableName: TableEntity,
            entitySourceType: EntitySourceType.QUERY,
            lookup: {
                paramKey: 'tableId',
                entityField: 'id',
            },
        }),
    },
    schema: {
        querystring: ListRecordsRequest,
        tags: ['records'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'List records',
        response: {
            [StatusCodes.OK]: SeekPage(PopulatedRecord),
        },
    },
}

