import { ConcurrencyPool, Project } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

type ConcurrencyPoolSchema = ConcurrencyPool & {
    projects: Project[]
}

export const ConcurrencyPoolEntity = new EntitySchema<ConcurrencyPoolSchema>({
    name: 'concurrency_pool',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            type: String,
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
    relations: {
        projects: {
            type: 'one-to-many',
            target: 'project',
            inverseSide: 'pool',
        },
    },
})
