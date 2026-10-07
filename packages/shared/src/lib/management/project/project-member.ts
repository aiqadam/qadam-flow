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
    managedBy: z.enum(ProjectMemberManagedBy),
})

export type ProjectMemberWithUser = z.infer<typeof ProjectMemberWithUser>

// A platform user who is not yet in the project and can be added to it directly. Deliberately
// narrower than `UserWithMetaInformation`: the members tab only needs enough to render a picker,
// and the platform-scoped user list endpoint is admin-only, so a project ADMIN cannot read it.
export const ProjectMemberCandidate = z.object({
    userId: ApId,
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
})

export type ProjectMemberCandidate = z.infer<typeof ProjectMemberCandidate>

export const UpdateProjectMemberRequestBody = z.object({
    projectRole: z.enum(DefaultProjectRole),
})

export type UpdateProjectMemberRequestBody = z.infer<typeof UpdateProjectMemberRequestBody>

export const ListProjectMembersParams = z.object({
    projectId: ApId,
})

export type ListProjectMembersParams = z.infer<typeof ListProjectMembersParams>

export const ListProjectMemberCandidatesParams = z.object({
    projectId: ApId,
    // Optional server-side filter over email/first/last name. The picker searches as the user
    // types so a platform larger than the result cap is still fully reachable.
    search: z.string().optional(),
})

export type ListProjectMemberCandidatesParams = z.infer<typeof ListProjectMemberCandidatesParams>

export const GetProjectMemberRoleParams = z.object({
    projectId: ApId,
})

export type GetProjectMemberRoleParams = z.infer<typeof GetProjectMemberRoleParams>

export const ProjectMemberRoleResponse = z.object({
    role: z.enum([DefaultProjectRole.ADMIN, DefaultProjectRole.EDITOR, DefaultProjectRole.VIEWER]),
})

export type ProjectMemberRoleResponse = z.infer<typeof ProjectMemberRoleResponse>
