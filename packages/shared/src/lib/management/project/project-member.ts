import { z } from 'zod'
import { BaseModelSchema } from '../../core/common/base-model'
import { ApId } from '../../core/common/id-generator'

export enum DefaultProjectRole {
    ADMIN = 'Admin',
    EDITOR = 'Editor',
    VIEWER = 'Viewer',
}

export const ProjectMemberSchema = z.object({
    ...BaseModelSchema,
    userId: ApId,
    projectId: ApId,
    projectRoleId: ApId,
    platformId: ApId,
})

export type ProjectMember = z.infer<typeof ProjectMemberSchema>

export const ProjectMemberWithUser = z.object({
    id: ApId,
    userId: ApId,
    projectId: ApId,
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    projectRole: z.string(),
})

export type ProjectMemberWithUser = z.infer<typeof ProjectMemberWithUser>

export const ListProjectMembersParams = z.object({
    projectId: ApId,
})

export type ListProjectMembersParams = z.infer<typeof ListProjectMembersParams>
