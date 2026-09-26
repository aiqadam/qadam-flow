import { z } from 'zod'
import { BaseModelSchema } from '../../core/common/base-model'
import { ApId } from '../../core/common/id-generator'

export enum DefaultProjectRole {
    ADMIN = 'Admin',
    EDITOR = 'Editor',
    VIEWER = 'Viewer',
}

// Distinguishes a membership an admin added by hand from one an LDAP group mapping created, so
// reconcile (`.agents/features/ldap.md` Phase 2) knows which rows it may update or remove — a
// manually-added membership must never be touched by the directory, even when it also happens to
// match a group mapping.
export enum ProjectMemberManagedBy {
    MANUAL = 'MANUAL',
    LDAP = 'LDAP',
}

export const ProjectMemberSchema = z.object({
    ...BaseModelSchema,
    userId: ApId,
    projectId: ApId,
    projectRoleId: ApId,
    platformId: ApId,
    managedBy: z.enum(ProjectMemberManagedBy),
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

export const GetProjectMemberRoleParams = z.object({
    projectId: ApId,
})

export type GetProjectMemberRoleParams = z.infer<typeof GetProjectMemberRoleParams>

export const ProjectMemberRoleResponse = z.object({
    role: z.enum([DefaultProjectRole.ADMIN, DefaultProjectRole.EDITOR, DefaultProjectRole.VIEWER]),
})

export type ProjectMemberRoleResponse = z.infer<typeof ProjectMemberRoleResponse>
