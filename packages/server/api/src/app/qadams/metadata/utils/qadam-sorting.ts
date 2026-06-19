import { QadamOrderBy, QadamSortBy } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { QadamMetadataSchema } from '../qadam-metadata-entity'


export const qadamSorting = {
    sortAndOrder: (
        sortBy: QadamSortBy | undefined,
        orderBy: QadamOrderBy | undefined,
        pieces: QadamMetadataSchema[],
    ): QadamMetadataSchema[] => {
        const sortByDefault = sortBy ?? QadamSortBy.NAME
        const orderByDefault = orderBy ?? QadamOrderBy.ASC
        const sortedPiece = sortPieces(sortByDefault, pieces)

        return reverseIfDesc(orderByDefault, sortedPiece)
    },
}


const sortPieces = (
    sortBy: QadamSortBy | undefined,
    pieces: QadamMetadataSchema[],
): QadamMetadataSchema[] => {
    const sortByDefault = sortBy ?? QadamSortBy.NAME
    switch (sortByDefault) {
        case QadamSortBy.POPULARITY: {
            return sortByPopularity(pieces)
        }
        case QadamSortBy.NAME: {
            return sortByName(pieces)
        }
        case QadamSortBy.UPDATED: {
            return sortByUpdated(pieces)
        }
        case QadamSortBy.CREATED: {
            return sortByCreated(pieces)
        }
    }
}
const reverseIfDesc = (
    orderBy: QadamOrderBy,
    pieces: QadamMetadataSchema[],
): QadamMetadataSchema[] => {
    if (orderBy === QadamOrderBy.ASC) {
        return pieces
    }
    return pieces.reverse()
}

const sortByPopularity = (pieces: QadamMetadataSchema[]): QadamMetadataSchema[] => {
    return pieces.sort((a, b) =>
        a.projectUsage - b.projectUsage,
    )
}


const sortByName = (pieces: QadamMetadataSchema[]): QadamMetadataSchema[] => {
    return pieces.sort((a, b) =>
        a.displayName.toLocaleLowerCase().localeCompare(b.displayName.toLocaleLowerCase()),
    )
}

const sortByCreated = (pieces: QadamMetadataSchema[]): QadamMetadataSchema[] => {
    return pieces.sort(
        (a, b) => dayjs(a.created).unix() - dayjs(b.created).unix(),
    )
}

const sortByUpdated = (pieces: QadamMetadataSchema[]): QadamMetadataSchema[] => {
    return pieces.sort(
        (a, b) => dayjs(a.updated).unix() - dayjs(b.updated).unix(),
    )
}
