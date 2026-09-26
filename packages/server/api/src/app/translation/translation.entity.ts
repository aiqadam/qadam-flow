import { Project, Translation } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type TranslationSchema = Translation & {
    project?: Project
}

export const TranslationEntity = new EntitySchema<TranslationSchema>({
    name: 'translation',
    columns: {
        ...BaseColumnSchemaPart,
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        // No FK relation, deliberately: same precedent as `file.entity.ts` — `platformId` is
        // derivable from `projectId` (every project belongs to exactly one platform) and platforms
        // are not deleted the way projects are, so there is no cascade behavior for it to need.
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
    relations: {
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_translation_project_id',
            },
        },
    },
})
