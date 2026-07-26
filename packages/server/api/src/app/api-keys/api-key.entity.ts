import { ApiKey, Platform } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

type ApiKeySchema = ApiKey & {
    platform?: Platform
}

export const ApiKeyEntity = new EntitySchema<ApiKeySchema>({
    name: 'api_key',
    columns: {
        ...BaseColumnSchemaPart,
        displayName: {
            type: String,
            nullable: false,
        },
        platformId: {
            type: String,
            nullable: false,
        },
        hashedValue: {
            type: String,
            nullable: false,
        },
        truncatedValue: {
            type: String,
            nullable: false,
        },
    },
    indices: [
        {
            name: 'idx_api_key_platform_id',
            columns: ['platformId'],
            unique: false,
        },
        {
            name: 'idx_api_key_hashed_value',
            columns: ['hashedValue'],
            unique: true,
        },
    ],
    relations: {
        platform: {
            type: 'many-to-one',
            target: 'platform',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_api_key_platform_id',
            },
        },
    },
})
