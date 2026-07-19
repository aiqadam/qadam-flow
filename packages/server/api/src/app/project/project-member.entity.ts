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
    },
    indices: [
        { columns: ['userId', 'projectId'], unique: true },
    ],
})
