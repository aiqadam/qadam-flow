import { z } from 'zod'
import { ApMultipartFile } from '../../../core/common'
import { OptionalArrayFromQuery, OptionalBooleanFromQuery } from '../../../core/common/base-model'
import { PackageType, QadamCategory } from '../qadam'

export const EXACT_VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+$'
export const EXACT_VERSION_REGEX = new RegExp(EXACT_VERSION_PATTERN)
const VERSION_PATTERN = '^([~^])?[0-9]+\\.[0-9]+\\.[0-9]+$'

export const ExactVersionType = z.string().regex(new RegExp(EXACT_VERSION_PATTERN))

export const VersionType = z.string().regex(new RegExp(VERSION_PATTERN))

export enum SuggestionType {
    ACTION = 'ACTION',
    TRIGGER = 'TRIGGER',
    ACTION_AND_TRIGGER = 'ACTION_AND_TRIGGER',
}
export enum QadamSortBy {
    NAME = 'NAME',
    UPDATED = 'UPDATED',
    CREATED = 'CREATED',
    POPULARITY = 'POPULARITY',
}

export enum QadamOrderBy {
    ASC = 'ASC',
    DESC = 'DESC',
}

export const GetQadamRequestWithScopeParams = z.object({
    name: z.string(),
    scope: z.string(),
})

export type GetQadamRequestWithScopeParams = z.infer<typeof GetQadamRequestWithScopeParams>


export const GetQadamRequestParams = z.object({
    name: z.string(),
})

export type GetQadamRequestParams = z.infer<typeof GetQadamRequestParams>

export const ListQadamsRequestQuery = z.object({
    projectId: z.string().optional(),
    release: ExactVersionType.optional(),
    includeTags: OptionalBooleanFromQuery,
    includeHidden: OptionalBooleanFromQuery,
    searchQuery: z.string().optional(),
    sortBy: z.nativeEnum(QadamSortBy).optional(),
    orderBy: z.nativeEnum(QadamOrderBy).optional(),
    categories: OptionalArrayFromQuery(z.nativeEnum(QadamCategory)),
    suggestionType: z.nativeEnum(SuggestionType).optional(),
    locale: z.string().optional(),
})

export type ListQadamsRequestQuery = z.infer<typeof ListQadamsRequestQuery>


export const RegistryQadamsRequestQuery = z.object({
    release: ExactVersionType,
})

export type RegistryQadamsRequestQuery = z.infer<typeof RegistryQadamsRequestQuery>

export const GetQadamRequestQuery = z.object({
    version: VersionType.optional(),
    projectId: z.string().optional(),
    locale: z.string().optional(),
})

export type GetQadamRequestQuery = z.infer<typeof GetQadamRequestQuery>

export const QadamOptionRequest = z.object({
    projectId: z.string(),
    qadamName: z.string(),
    qadamVersion: VersionType,
    actionOrTriggerName: z.string(),
    propertyName: z.string(),
    flowId: z.string(),
    flowVersionId: z.string(),
    input: z.any(),
    searchValue: z.string().optional(),
})

export type QadamOptionRequest = z.infer<typeof QadamOptionRequest>

export enum QadamScope {
    PLATFORM = 'PLATFORM',
}

export const AddQadamRequestBody = z.union([
    z.object({
        packageType: z.literal(PackageType.ARCHIVE),
        scope: z.literal(QadamScope.PLATFORM),
        qadamName: z.string().min(1),
        qadamVersion: ExactVersionType,
        qadamArchive: ApMultipartFile,
    }).describe('Private Qadam'),
    z.object({
        packageType: z.literal(PackageType.REGISTRY),
        scope: z.literal(QadamScope.PLATFORM),
        qadamName: z.string().min(1),
        qadamVersion: ExactVersionType,
    }).describe('NPM Qadam'),
])

export type AddQadamRequestBody = z.infer<typeof AddQadamRequestBody>

