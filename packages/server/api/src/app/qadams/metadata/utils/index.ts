import { PlatformId, QadamCategory, QadamOrderBy, QadamSortBy, SuggestionType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { QadamMetadataSchema } from '../qadam-metadata-entity'
import { qadamSearching } from './qadam-searching'
import { qadamSorting } from './qadam-sorting'

export const qadamListUtils = (_log: FastifyBaseLogger) => ({
    async filterPieces(params: FilterPiecesParams): Promise<QadamMetadataSchema[]> {
        const sortedPieces = qadamSorting.sortAndOrder(
            params.sortBy,
            params.orderBy,
            params.pieces,
        )

        return qadamSearching.search({
            categories: params.categories,
            searchQuery: params.searchQuery,
            pieces: sortedPieces,
            suggestionType: params.suggestionType,
        })
    },
})

export type FilterPiecesParams = {
    includeHidden?: boolean
    platformId?: PlatformId
    searchQuery?: string
    categories?: QadamCategory[]
    projectId?: string
    sortBy?: QadamSortBy
    orderBy?: QadamOrderBy
    pieces: QadamMetadataSchema[]
    suggestionType?: SuggestionType
}

export * from './qadam-cache-utils'