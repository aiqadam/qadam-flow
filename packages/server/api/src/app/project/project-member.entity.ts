import { ProjectMember } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

export const ProjectMemberEntity = new EntitySchema<ProjectMember>({
    name: 'project_member',
    columns: {
        ...BaseColumnSchemaPart,
        userId: { type: String, nullable: false },
        projectId: { type: String, nullable: false },
        projectRoleId: { type: String, nullable: false },
        platformId: { type: String, nullable: false },
        // 'MANUAL' for every row created by an admin/invitation; 'LDAP' for a row an LDAP group
        // mapping created — reconcile (`ldap-group-mapping-service.ts`) only ever updates or
        // removes rows carrying its own marker, never a manually-added one.
        managedBy: { type: String, nullable: false, default: 'MANUAL' },
    },
    indices: [
        { name: 'idx_project_member_user_project', columns: ['userId', 'projectId'], unique: true },
    ],
})
