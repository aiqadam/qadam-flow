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
        // LDAP-managed role is ever reverted by a mapping that no longer grants one, or overwritten
        // (in either direction) by one that does; a matching mapping may only ever *raise* a MANUAL
        // role (which is what flips it to LDAP going forward), never lower or hold it at or below
        // its current rank, and a MANUAL role is never demoted by a mapping that no longer matches
        // at all (`.agents/features/ldap.md` Phase 2).
        platformRoleManagedBy: {
            type: String,
            nullable: false,
            default: 'MANUAL',
        },
        // The MANUAL `platformRole` a group mapping's raise-only rule preserved at the moment it
        // last raised a MANUAL role to an LDAP-managed one — e.g. an admin's own OPERATOR promoted
        // to ADMIN by a matching group. Read back only by the mapping's own revert path (no
        // resolved role, currently LDAP-managed): the role returns to this baseline, not to
        // MEMBER, because "manual roles are never demoted" also means a manual role a mapping once
        // raised is never demoted *below where the admin themselves left it* once the group grant
        // goes away. Cleared (reset to null) by the same admin role write that already resets
        // provenance to MANUAL, and by the mapping's own revert once it has been consumed
        // (`.agents/features/ldap.md` Phase 2).
        platformRoleManualBaseline: {
            type: String,
            nullable: true,
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
