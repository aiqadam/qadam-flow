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
