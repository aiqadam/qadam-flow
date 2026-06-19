import {
    ErrorCode,
    isNil,
    ListTemplatesRequestQuery,
    QadamFlowError,
    SeekPage,
    Template,
} from '@aiqadam/shared'
import seedCategories from './seed/categories.json'
import seedTemplates from './seed/templates.json'

const templates: Template[] = seedTemplates as unknown as Template[]
const categories: string[] = seedCategories

export const communityTemplates = {
    getOrThrow: async (id: string): Promise<Template> => {
        const template = templates.find((t) => t.id === id)
        if (isNil(template)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'template',
                    entityId: id,
                    message: `Template ${id} not found`,
                },
            })
        }
        return template
    },
    getCategories: async (): Promise<string[]> => {
        return categories
    },
    list: async (request: ListTemplatesRequestQuery): Promise<SeekPage<Template>> => {
        let filtered = templates

        const { qadams, category, search, tags } = request
        if (!isNil(qadams) && qadams.length > 0) {
            filtered = filtered.filter((t) =>
                qadams.some((q) => t.qadams.includes(q)),
            )
        }
        if (!isNil(category)) {
            filtered = filtered.filter((t) =>
                t.categories.includes(category),
            )
        }
        if (!isNil(search)) {
            const lowerSearch = search.toLowerCase()
            filtered = filtered.filter((t) =>
                t.name.toLowerCase().includes(lowerSearch)
                || t.summary.toLowerCase().includes(lowerSearch)
                || t.description.toLowerCase().includes(lowerSearch),
            )
        }
        if (!isNil(tags) && tags.length > 0) {
            filtered = filtered.filter((t) =>
                tags.every((tag) =>
                    t.tags.some((tt) => tt.title === tag),
                ),
            )
        }

        return {
            data: filtered,
            next: null,
            previous: null,
        }
    },
}
