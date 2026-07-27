import { ConcurrencyPool, Project } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

type ConcurrencyPoolSchema = ConcurrencyPool & {
    projects: Project[]
}

export const ConcurrencyPoolEntity = new EntitySchema<ConcurrencyPoolSchema>({
    name: 'concurrency_pool',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        key: {
            type: String,
            nullable: false,
        },
        maxConcurrentJobs: {
            type: Number,
            nullable: false,
        },
    },
    indices: [
        {
            name: 'idx_concurrency_pool_platform_key',
            columns: ['platformId', 'key'],
            unique: true,
        },
    ],
    relations: {
        projects: {
            type: 'one-to-many',
            target: 'project',
            inverseSide: 'pool',
        },
    },
})
