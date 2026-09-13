import { apId, assertNotNullOrUndefined, CreateFieldRequest, ErrorCode, Field, FieldState, FieldType, isNil, QadamFlowError, spreadIfDefined, UpdateFieldRequest } from '@aiqadam/shared'
import { EntityManager, In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { FieldEntity } from './field.entity'

const fieldRepo = repoFactory<Field>(FieldEntity)

export const fieldService = {
    async create({ request, projectId, entityManager, created }: CreateParams): Promise<Field> {
        await this.validateCount({ projectId, tableId: request.tableId, entityManager })
        // `created` is accepted so a caller building a whole table's columns at once can make their
        // order reproducible. Left to the column default it is `now()`, which inside a transaction
        // is the *transaction* timestamp and therefore identical for every field of that batch —
        // and `getAll` orders by `created` with no tiebreaker, so the column order would be
        // whatever the heap happened to return.
        const field = await fieldRepo(entityManager).save({
            ...request,
            ...spreadIfDefined('created', created?.toISOString()),
            projectId,
            id: apId(),
            externalId: request.externalId ?? apId(),
        })
        return field
    },

    async createFromState({ projectId, field, tableId, entityManager, created }: CreateFromStateParams): Promise<Field> {
        switch (field.type) {
            case FieldType.STATIC_DROPDOWN: {
                assertNotNullOrUndefined(field.data, 'Data is required for static dropdown field')
                return this.create({
                    projectId,
                    entityManager,
                    created,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        data: field.data,
                        externalId: field.externalId,
                    },
                })
            }
            case FieldType.DATE:
            case FieldType.NUMBER:
            case FieldType.TEXT: {
                return this.create({
                    projectId,
                    entityManager,
                    created,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        externalId: field.externalId,
                    },
                })
            }
            default: {
                throw new QadamFlowError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        message: `Unsupported field type: ${field.type}`,
                    },
                })
            }
        }
    },

    async getAll({ projectId, tableId, entityManager }: GetAllParams): Promise<Field[]> {
        return fieldRepo(entityManager).find({
            where: { projectId, tableId },
            order: {
                created: 'ASC',
            },
        })
    },

    async getAllByTableIds({ projectId, tableIds }: GetAllByTableIdsParams): Promise<Map<string, Field[]>> {
        const fields = await fieldRepo().find({
            where: { projectId, tableId: In(tableIds) },
            order: {
                created: 'ASC',
            },
        })
        const result = new Map<string, Field[]>()
        for (const tableId of tableIds) {
            result.set(tableId, [])
        }
        for (const field of fields) {
            result.get(field.tableId)?.push(field)
        }
        return result
    },

    async getById({ id, projectId }: GetByIdParams): Promise<Field> {
        const field = await fieldRepo().findOne({
            where: { id, projectId },
        })

        if (isNil(field)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'Field',
                    entityId: id,
                },
            })
        }

        return field
    },

    async delete({ id, projectId, entityManager }: DeleteParams): Promise<void> {
        await fieldRepo(entityManager).delete({
            id,
            projectId,
        })
    },

    async update({ id, projectId, request }: UpdateParams): Promise<Field> {
        await fieldRepo().update({
            id,
            projectId,
        }, {
            name: request.name,
        })
        return this.getById({ id, projectId })
    },

    async count({ projectId, tableId, entityManager }: CountParams): Promise<number> {
        return fieldRepo(entityManager).count({
            where: { projectId, tableId },
        })
    },
    async validateCount(params: CountParams): Promise<void> {
        const countRes = await this.count(params)
        if (countRes + 1 > system.getNumberOrThrow(AppSystemProp.MAX_FIELDS_PER_TABLE)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Max fields per table reached: ${system.getNumberOrThrow(AppSystemProp.MAX_FIELDS_PER_TABLE)}`,
                },
            })
        }
    },
}

type CreateParams = {
    projectId: string
    request: CreateFieldRequest
    entityManager?: EntityManager
    created?: Date
}

type CreateFromStateParams = {
    projectId: string
    field: FieldState
    tableId: string
    entityManager?: EntityManager
    created?: Date
}

type GetAllParams = {
    projectId: string
    tableId: string
    entityManager?: EntityManager
}

type GetAllByTableIdsParams = {
    projectId: string
    tableIds: string[]
}

type GetByIdParams = {
    id: string
    projectId: string
}

type DeleteParams = {
    id: string
    projectId: string
    entityManager?: EntityManager
}

type UpdateParams = {
    id: string
    projectId: string
    request: UpdateFieldRequest
}

type CountParams = {
    projectId: string
    tableId: string
    entityManager?: EntityManager
}
