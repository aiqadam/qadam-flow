import { z } from 'zod'
import { Nullable, OptionalArrayFromQuery } from '../../core/common/base-model'
import { Metadata } from '../../core/common/metadata'
import { SAFE_STRING_PATTERN } from '../../core/common/security'
import { ProjectIcon, ProjectType, QadamsFilterType } from './project'

export const UpdateProjectPlatformRequest = z.object({
    releasesEnabled: z.boolean().optional(),
    displayName: z.string().regex(new RegExp(SAFE_STRING_PATTERN)).optional(),
    externalId: z.string().optional(),
    metadata: Metadata.optional(),
    icon: ProjectIcon.optional(),
    plan: z.object({
        pieces: z.array(z.string()).optional(),
        piecesFilterType: z.nativeEnum(QadamsFilterType).optional(),
    }).optional(),
    globalConnectionExternalIds: z.array(z.string()).optional(),
    // The column is a Postgres `integer` — anything past 2147483647 fails the write with a raw
    // 22003 (numeric_value_out_of_range), which would otherwise surface as an opaque 500 instead
    // of a clean 400 at the schema boundary.
    maxConcurrentJobs: Nullable(z.number().int().positive().max(2147483647)).optional(),
})

export type UpdateProjectPlatformRequest = z.infer<typeof UpdateProjectPlatformRequest>

export const CreatePlatformProjectRequest = z.object({
    displayName: z.string().regex(new RegExp(SAFE_STRING_PATTERN)),
    externalId: Nullable(z.string()),
    metadata: Nullable(Metadata),
    // Kept in sync with UpdateProjectPlatformRequest's bound — see its comment.
    maxConcurrentJobs: Nullable(z.number().int().positive().max(2147483647)),
    globalConnectionExternalIds: z.array(z.string()).optional(),
    alertReceiverEmail: z.email().nullable().optional(),
})

export type CreatePlatformProjectRequest = z.infer<typeof CreatePlatformProjectRequest>

export const ListProjectRequestForPlatformQueryParams = z.object({
    externalId: z.string().optional(),
    externalUserId: z.string().optional(),
    limit: z.coerce.number().optional(),
    cursor: z.string().optional(),
    displayName: z.string().optional(),
    types: OptionalArrayFromQuery(z.nativeEnum(ProjectType)),
})

export type ListProjectRequestForPlatformQueryParams = z.infer<typeof ListProjectRequestForPlatformQueryParams>
