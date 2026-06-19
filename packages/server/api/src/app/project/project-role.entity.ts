import { ProjectRole, UserInvitation } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../database/database-common'

type ProjectRoleSchema = ProjectRole & {
    invitations: UserInvitation[]
}

export const ProjectRoleEntity = new EntitySchema<ProjectRoleSchema>({
    name: 'project_role',
    columns: {
        ...BaseColumnSchemaPart,
        name: {
            type: String,
            nullable: false,
        },
        permissions: {
            type: String,
            array: true,
            nullable: false,
        },
        platformId: {
            type: String,
            nullable: true,
        },
        type: {
            type: String,
            nullable: false,
        },
    },
    relations: {
        invitations: {
            type: 'one-to-many',
            target: 'user_invitation',
            inverseSide: 'projectRole',
        },
    },
})
