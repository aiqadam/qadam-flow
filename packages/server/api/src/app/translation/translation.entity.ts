import { Translation } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

export type TranslationSchema = Translation

export const TranslationEntity = new EntitySchema<TranslationSchema>({
    name: 'translation',
    columns: {
        ...BaseColumnSchemaPart,
        projectId: {
            type: String,
            nullable: false,
        },
        platformId: {
            type: String,
            nullable: false,
        },
        key: {
            type: String,
            nullable: false,
        },
        values: {
            type: 'jsonb',
            nullable: false,
        },
        description: {
            type: String,
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_translation_project_id_and_key',
            columns: ['projectId', 'key'],
            unique: true,
        },
        {
            name: 'idx_translation_project_id',
            columns: ['projectId'],
        },
    ],
})
