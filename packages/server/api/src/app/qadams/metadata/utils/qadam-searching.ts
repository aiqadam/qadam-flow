import { ActionBase, TriggerBase } from '@aiqadam/qadams-framework'

import {
    QadamCategory,
    SuggestionType,
} from '@aiqadam/shared'
import Fuse from 'fuse.js'
import { QadamMetadataSchema } from '../qadam-metadata-entity'

export const qadamSearching = {
    search: (params: SearchParams): QadamMetadataSchema[] => {
        return filterBasedOnCategories(params.categories, filterBasedOnSearchQuery(params))
    },
}

type SearchParams = {
    categories: QadamCategory[] | undefined
    searchQuery: string | undefined
    pieces: QadamMetadataSchema[]
    suggestionType?: SuggestionType
}


const filterBasedOnSearchQuery = ({ searchQuery, pieces, suggestionType }: SearchParams): QadamMetadataSchema[] => {
    if (!searchQuery) {
        return pieces
    }
    const putActionsAndTriggersInAnArray = pieces.map((piece) => {
        const actions = suggestionType === SuggestionType.ACTION ||
                    suggestionType === SuggestionType.ACTION_AND_TRIGGER
            ? Object.values(piece.actions)
            : []

        const triggers = suggestionType === SuggestionType.TRIGGER ||
                    suggestionType === SuggestionType.ACTION_AND_TRIGGER
            ? Object.values(piece.triggers)
            : []
        return {
            ...piece,
            actions,
            triggers,
        }
    })

    const pieceWithTriggersAndActionsFilterKeys = [
        {
            name: 'displayName',
            weight: 3,
        },
        {
            name: 'description',
            weight: 1,
        },
        'actions.displayName',
        'actions.description',
        'triggers.displayName',
        'triggers.description',
    ]

    const fuse = new Fuse(putActionsAndTriggersInAnArray, {
        isCaseSensitive: false,
        shouldSort: true,
        keys: pieceWithTriggersAndActionsFilterKeys,
        threshold: 0.2,
        distance: 250,
    })

    return fuse.search(searchQuery).map(({ item }) => {
        const suggestedActions = searchForSuggestion(
            item.actions,
            searchQuery,
            item.displayName,
        )
        const suggestedTriggers = searchForSuggestion(
            item.triggers,
            searchQuery,
            item.displayName,
        )

        return {
            ...item,
            actions: suggestedActions,
            triggers: suggestedTriggers,
        }
    })
}

const filterBasedOnCategories = (categories: QadamCategory[] | undefined, pieces: QadamMetadataSchema[]): QadamMetadataSchema[] => {
    if (!categories) {
        return pieces
    }

    return pieces.filter((p) => {
        return categories.some((item) => (p.categories ?? []).includes(item))
    })
}

function searchForSuggestion<T extends ActionBase | TriggerBase>(
    actionsOrTriggers: T[],
    searchQuery: string,
    qadamDisplayName: string,
): Record<string, T> {
    const actionsOrTriggerWithPieceDisplayName = actionsOrTriggers.map(
        (actionOrTrigger) => ({
            ...actionOrTrigger,
            qadamDisplayName,
        }),
    )

    const nestedFuse = new Fuse(actionsOrTriggerWithPieceDisplayName, {
        isCaseSensitive: false,
        shouldSort: true,
        keys: ['qadamDisplayName', 'displayName', 'description'],
        threshold: 0.2,
    })
    const suggestions = nestedFuse.search(searchQuery)
    return suggestions.reduce<Record<string, T>>(
        (filteredSuggestions, { item }) => {
            filteredSuggestions[item.name] = {
                ...item,
                qadamDisplayName: undefined,
            }
            return filteredSuggestions
        },
        {},
    )
}
