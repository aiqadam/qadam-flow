import { User, UserFederatedIdentity } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../database/database-common'

export type UserFederatedIdentitySchema = UserFederatedIdentity & {
    user: User
}

// Rows deliberately survive deletion of the platform's LDAP config (only the `user` FK cascades)
// — the directory's own subject-to-user mapping is independent of whether the platform still has
// a config row configured, and re-adding the config later must not re-provision a second account
// for the same directory user.
export const UserFederatedIdentityEntity = new EntitySchema<UserFederatedIdentitySchema>({
    name: 'user_federated_identity',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        userId: {
            ...ApIdSchema,
            nullable: false,
        },
        provider: {
            type: String,
            nullable: false,
        },
        subject: {
            type: String,
            nullable: false,
        },
    },
    indices: [
        {
            name: 'idx_user_federated_identity_platform_provider_subject',
            columns: ['platformId', 'provider', 'subject'],
            unique: true,
        },
        {
            name: 'idx_user_federated_identity_platform_user_provider',
            columns: ['platformId', 'userId', 'provider'],
            unique: true,
        },
    ],
    relations: {
        user: {
            type: 'many-to-one',
            target: 'user',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'userId',
                foreignKeyConstraintName: 'fk_user_federated_identity_user_id',
            },
        },
    },
})
