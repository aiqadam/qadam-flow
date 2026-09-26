import { LdapConfig, Platform } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { z } from 'zod'
import { ApIdSchema, BaseColumnSchemaPart } from '../../database/database-common'
import { EncryptedObject } from '../../helper/encryption'

const PlatformLdapConfigEncrypted = z.object({
    id: z.string(),
    created: z.string(),
    updated: z.string(),
    platformId: z.string(),
    config: LdapConfig,
    bindPassword: EncryptedObject,
    caCertificate: EncryptedObject.nullable(),
})
type PlatformLdapConfigEncrypted = z.infer<typeof PlatformLdapConfigEncrypted>

export type PlatformLdapConfigSchema = PlatformLdapConfigEncrypted & {
    platform: Platform
}

export const PlatformLdapConfigEntity = new EntitySchema<PlatformLdapConfigSchema>({
    name: 'platform_ldap_config',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        config: {
            type: 'json',
            nullable: false,
        },
        bindPassword: {
            type: 'json',
            nullable: false,
        },
        caCertificate: {
            type: 'json',
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_platform_ldap_config_platform_id',
            columns: ['platformId'],
            unique: true,
        },
    ],
    relations: {
        platform: {
            type: 'one-to-one',
            target: 'platform',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_platform_ldap_config_platform_id',
            },
        },
    },
})
