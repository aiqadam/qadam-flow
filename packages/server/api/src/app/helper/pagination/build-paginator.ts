import { ErrorCode, isNil, QadamFlowError } from '@aiqadam/shared'
import { EntitySchema, ObjectLiteral } from 'typeorm'
import Paginator, { Order, OrderByConfig } from './paginator'

// The ceiling on one page for every cursor-paginated list. A larger request is clamped
// rather than rejected, so an old client asking for 10000 gets a cursor instead of a 400
// (#561). Reading a whole set is `unlimited: true`, which only server code can pass.
export const MAX_PAGE_SIZE = 1000

export function buildPaginator<Entity extends ObjectLiteral>(
    options: PaginationOptions<Entity>,
): Paginator<Entity> {
    const {
        entity,
        query = {},
        alias = entity.options.name.toLowerCase(),
        unlimited = false,
    } = options

    const paginator = new Paginator<Entity>(entity)

    paginator.setAlias(alias)

    if (query.afterCursor) {
        paginator.setAfterCursor(query.afterCursor)
    }

    if (query.beforeCursor) {
        paginator.setBeforeCursor(query.beforeCursor)
    }

    if (unlimited) {
        paginator.setUnlimited()
    }
    else if (!isNil(query.limit) && query.limit !== ZERO_MEANS_DEFAULT) {
        paginator.setLimit(clampLimit(query.limit))
    }

    if (query.orderBy) {
        if (Array.isArray(query.orderBy)) {
            paginator.setCompositeOrderBy(query.orderBy)
        }
        else {
            paginator.setOrderBy(query.orderBy)
            if (query.order) {
                paginator.setOrder(query.order as Order)
            }
        }
    }
    else if (query.order) {
        paginator.setOrder(query.order as Order)
    }

    return paginator
}

// Before #561 a falsy limit fell through to the paginator's default page, and published qadams
// still send `limit=0` (qadam-tables <= 0.4.6), so 0 keeps skipping the limit rather than a 400.
const ZERO_MEANS_DEFAULT = 0

// `-1` used to mean "every row" here, and 16 list DTOs passed it straight through (#561).
function clampLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'limit must be a positive integer' },
        })
    }
    return Math.min(limit, MAX_PAGE_SIZE)
}

export type PagingQuery = {
    afterCursor?: string
    beforeCursor?: string
    limit?: number
    order?: Order | 'ASC' | 'DESC'
    orderBy?: string | OrderByConfig[]
}

export type PaginationOptions<Entity> = {
    entity: EntitySchema<Entity>
    alias?: string
    query?: PagingQuery
    unlimited?: boolean
}
