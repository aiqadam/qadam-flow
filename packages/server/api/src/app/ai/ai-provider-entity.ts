import { AIProviderConfig, AIProviderName, BaseModelSchema, Platform } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { z } from 'zod'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'
import { EncryptedObject } from '../helper/encryption'

const AIProviderEncrypted = z.object({
    ...BaseModelSchema,
    displayName: z.string().min(1),
    platformId: z.string(),
    provider: z.nativeEnum(AIProviderName),
    auth: EncryptedObject,
    config: AIProviderConfig,
    enabledForChat: z.boolean().default(false),
})
type AIProviderEncrypted = z.infer<typeof AIProviderEncrypted>

export type AIProviderSchema = AIProviderEncrypted & {
    platform: Platform
    provider: AIProviderName
}

export const AIProviderEntity = new EntitySchema<AIProviderSchema>({
    name: 'ai_provider',
    columns: {
        ...BaseColumnSchemaPart,
        config: {
            type: 'json',
            nullable: false,
        },
        auth: {
            type: 'json',
            nullable: false,
        },
        provider: {
            type: String,
            nullable: false,
        },
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        displayName: {
            type: String,
            nullable: false,
        },
        enabledForChat: {
            type: Boolean,
            nullable: false,
            default: false,
        },
    },
    indices: [
        {
            // Renamed, not amended. TypeORM's schema builder compares an index by name, uniqueness
            // and columns and never reads `where`, so adding the predicate under the old name
            // generates an empty migration and check-migrations reports no drift — the entity and
            // the database would disagree silently and permanently.
            name: 'idx_ai_provider_platform_id_provider_not_custom',
            columns: ['platformId', 'provider'],
            unique: true,
            where: '"provider" <> \'custom\'',
        },
    ],
    relations: {
        platform: {
            type: 'many-to-one',
            target: 'platform',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_ai_provider_platform_id',
            },
        },
    },
})
