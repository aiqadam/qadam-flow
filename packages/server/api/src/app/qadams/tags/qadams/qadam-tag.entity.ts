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
            name: 'uq_qadam_tag_tag_id_qadam_name',
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
                foreignKeyConstraintName: 'fk_qadam_tag_tag_id',
            },
        },
        platform: {
            target: 'platform',
            type: 'many-to-one',
            cascade: true,
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_qadam_tag_platform_id',
            },
        },
    },
})
