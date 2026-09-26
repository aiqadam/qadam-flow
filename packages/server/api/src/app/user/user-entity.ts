import { Project, User, UserBadge, UserIdentity } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

export type UserSchema = User & {
    projects: Project[]
    identity: UserIdentity
    badges: UserBadge[]
}

export const UserEntity = new EntitySchema<UserSchema>({
    name: 'user',
    columns: {
        ...BaseColumnSchemaPart,
        status: {
            type: String,
        },
        platformRole: {
            type: String,
            nullable: false,
        },
        // Tracks who last decided `platformRole` — MANUAL for every admin-set change (including
        // through `POST /v1/users/:id`), LDAP for a role an LDAP group mapping granted. Only an
        // LDAP-managed role is ever reverted by a mapping that no longer grants one; a MANUAL role
        // is never demoted by one (`.agents/features/ldap.md` Phase 2).
        platformRoleManagedBy: {
            type: String,
            nullable: false,
            default: 'MANUAL',
        },
        identityId: {
            type: String,
            nullable: false,
        },
        externalId: {
            type: String,
            nullable: true,
        },
        platformId: {
            type: String,
            nullable: true,
        },
        lastActiveDate: {
            type: 'timestamp with time zone',
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_user_platform_id_email',
            columns: ['platformId', 'identityId'],
            unique: true,
        },
        {
            name: 'idx_user_platform_id_external_id',
            columns: ['platformId', 'externalId'],
            unique: true,
        },
        {
            name: 'idx_user_identity_id',
            columns: ['identityId'],
        },
    ],
    relations: {
        projects: {
            type: 'one-to-many',
            target: 'project',
            inverseSide: 'owner',
        },
        identity: {
            type: 'many-to-one',
            target: 'user_identity',
            joinColumn: {
                name: 'identityId',
                referencedColumnName: 'id',
                foreignKeyConstraintName: 'fk_user_identity_id',
            },
        },
        badges: {
            type: 'one-to-many',
            target: 'user_badge',
            inverseSide: 'user',
        },
    },
})
