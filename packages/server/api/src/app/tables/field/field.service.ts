import { apId, assertNotNullOrUndefined, CreateFieldRequest, ErrorCode, Field, FieldState, FieldType, formErrors, isNil, QadamFlowError, spreadIfDefined, tryCatchSync, UpdateFieldRequest } from '@aiqadam/shared'
import { EntityManager, In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { tableKey } from '../record/key-reader'
import { TableEntity } from '../table/table.entity'
import { FieldEntity } from './field.entity'

const fieldRepo = repoFactory<Field>(FieldEntity)
// TableEntity directly, not tableService — table.service.ts already imports
// fieldService, so importing tableService here would be a circular module
// dependency. The entity has none of that baggage.
const tableRepoForKeyGuard = repoFactory(TableEntity)

export const fieldService = {
    async create({ request, projectId, entityManager, created }: CreateParams): Promise<Field> {
        await this.validateCount({ projectId, tableId: request.tableId, entityManager })
        if (request.type === FieldType.JSON) {
            assertValidJsonFieldSchema(request.data?.schema)
        }
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
                assertNotNullOrUndefined(field.data?.options, 'Data is required for static dropdown field')
                return this.create({
                    projectId,
                    entityManager,
                    created,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        data: { options: field.data.options },
                        externalId: field.externalId,
                    },
                })
            }
            case FieldType.JSON: {
                return this.create({
                    projectId,
                    entityManager,
                    created,
                    request: {
                        name: field.name,
                        type: field.type,
                        tableId,
                        externalId: field.externalId,
                        ...spreadIfDefined('data', isNil(field.data?.schema) ? undefined : { schema: field.data.schema }),
                    },
                })
            }
            case FieldType.DATE:
            case FieldType.NUMBER:
            case FieldType.BOOLEAN:
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
        const field = await fieldRepo(entityManager).findOne({ where: { id, projectId } })
        if (!isNil(field)) {
            // Under the same shared table-key lock every record write takes, and for the
            // same reason: read without it, the guard below can see `keyFieldIds: null`
            // while a declareKey that is about to commit is already holding the exclusive
            // side. The key would then name a field this call has deleted, and every later
            // key derivation would read that column as permanently empty — a key quietly
            // narrower than the one the table declared. Only meaningful when there is a
            // transaction to scope the lock to; the import path passes one.
            if (!isNil(entityManager)) {
                await entityManager.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [tableKey.lockName({ projectId, tableId: field.tableId })])
            }
            await assertFieldNotInDeclaredKey({ field, projectId, entityManager })
        }
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

// A JSON field's optional `data.schema` is a JSON-Schema-shaped string, not raw JSON —
// stored and validated as text the same way every other field-level shape (e.g.
// STATIC_DROPDOWN's `options`) already is. Checked once, at field-creation time,
// against real cell values checked in cell-validation.ts on every write.
function assertValidJsonFieldSchema(schema: string | undefined): void {
    if (isNil(schema)) {
        return
    }
    const { data, error } = tryCatchSync<unknown>(() => JSON.parse(schema))
    if (error !== null || isNil(data) || typeof data !== 'object' || Array.isArray(data)) {
        const message = formErrors.invalidJsonValue
        throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Field data.schema must be a JSON object (a JSON Schema-shaped string), got "${schema.length > 100 ? `${schema.slice(0, 100)}…` : schema}".`)
    }
}

// A field that is part of a table's declared key (#409) cannot be deleted — doing so
// would leave `table.keyFieldIds` naming a field that no longer exists, and every
// future write's keyValue derivation (tableKey.buildValueReader in record/key-reader.ts) would
// silently treat the missing column as always-empty, collapsing every row's key to
// the same value the moment a second such field was also removed.
async function assertFieldNotInDeclaredKey({ field, projectId, entityManager }: { field: Field, projectId: string, entityManager?: EntityManager }): Promise<void> {
    const table = await tableRepoForKeyGuard(entityManager).findOne({ where: { id: field.tableId, projectId } })
    if (isNil(table) || isNil(table.keyFieldIds) || !table.keyFieldIds.includes(field.id)) {
        return
    }
    const message = formErrors.keyFieldInUse
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, `Field "${field.name}" is part of table "${table.name}"'s declared key. Clear the table's key declaration first.`)
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
