import { Platform, QadamTag, Tag } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../../../database/database-common'

export type QadamTagSchema = QadamTag & {
    tag: Tag
    platform: Platform
}
export const QadamTagEntity = new EntitySchema<QadamTagSchema>({
    name: 'qadam_tag',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            type: String,
        },
        qadamName: {
            type: String,
        },
        tagId: {
            type: String,
        },
    },
    uniques: [
        {
            columns: ['tagId', 'qadamName'],
        },
    ],
    indices: [
        {
            name: 'tag_platformId',
            columns: ['platformId'],
        },
    ],
    relations: {
        tag: {
            target: 'tag',
            type: 'many-to-one',
            cascade: true,
            joinColumn: {
                name: 'tagId',
            },
        },
        platform: {
            target: 'platform',
            type: 'many-to-one',
            cascade: true,
            joinColumn: {
                name: 'platformId',
            },
        },
    },
})
