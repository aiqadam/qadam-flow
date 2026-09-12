import { STORE_KEY_MAX_LENGTH, StoreEntry } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import {
    ApIdSchema,
    BaseColumnSchemaPart,
} from '../database/database-common'

type StoreEntrySchema = StoreEntry

export const StoreEntryEntity = new EntitySchema<StoreEntrySchema>({
    name: 'store-entry',
    columns: {
        ...BaseColumnSchemaPart,
        key: {
            type: String,
            length: STORE_KEY_MAX_LENGTH,
        },
        projectId: ApIdSchema,
        value: {
            type: 'jsonb',
            nullable: true,
        },
        expiresAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_store_entry_expires_at',
            columns: ['expiresAt'],
        },
    ],
    uniques: [
        {
            name: 'uq_store_entry_project_id_key',
            columns: ['projectId', 'key'],
        },
    ],
})
