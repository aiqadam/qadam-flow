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
        // Set only by the reconcile job when it deactivates this user because the directory
        // account is gone or disabled; cleared when reconcile reactivates them. Never set by a
        // sign-in, and never by an admin's own deactivation — reconcile reads it back to decide
        // whether *it* may reactivate the user, so a manual admin deactivation always sticks.
        directoryDisabledAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        // Round 3 (app-sec finding #5): stamped every time reconcile actually resolves this
        // identity's directory state within its per-platform time budget. `listByPlatformAndProvider`'s
        // `orderByLastReconciledAt` reads this back (oldest/never-reconciled first, `NULLS FIRST`) so
        // the starting point rotates across ticks instead of a slow/huge directory always starving
        // the same prefix of users.
        lastReconciledAt: {
            type: 'timestamp with time zone',
            nullable: true,
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
        {
            name: 'idx_user_federated_identity_platform_provider_last_reconciled',
            columns: ['platformId', 'provider', 'lastReconciledAt'],
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
