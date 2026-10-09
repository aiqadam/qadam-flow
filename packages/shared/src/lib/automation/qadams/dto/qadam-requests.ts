import { z } from 'zod'
import { ApMultipartFile } from '../../../core/common'
import { OptionalArrayFromQuery, OptionalBooleanFromQuery } from '../../../core/common/base-model'
import { formErrors } from '../../../form-errors'
import { PackageType, QadamCategory } from '../qadam'

export const EXACT_VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+$'
export const EXACT_VERSION_REGEX = new RegExp(EXACT_VERSION_PATTERN)
const VERSION_PATTERN = '^([~^])?[0-9]+\\.[0-9]+\\.[0-9]+$'
// A semver prerelease identifier: a number without a leading zero, or alphanumerics and hyphens.
const PRERELEASE_IDENTIFIER = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
// The platform version as `apVersionUtil.getCurrentRelease()` reports it: a release, or a prerelease
// such as `2.1.0-main.5` on images built from `main` (ADR-0001, #798). Never build metadata.
const PLATFORM_RELEASE_PATTERN = `^[0-9]+\\.[0-9]+\\.[0-9]+(-${PRERELEASE_IDENTIFIER}(\\.${PRERELEASE_IDENTIFIER})*)?$`

export const ExactVersionType = z.string().regex(new RegExp(EXACT_VERSION_PATTERN))

export const VersionType = z.string().regex(new RegExp(VERSION_PATTERN))

const PlatformReleaseType = z.string().regex(new RegExp(PLATFORM_RELEASE_PATTERN))

// The npm package-name shape (lower-case, optional `@scope/`, no leading `.` or `_`). A qadam name
// becomes a directory under the worker's install workspace, a key in its bunfig.toml and a
// `bun install --filter` path, so anything outside this grammar must be refused before it is
// stored or reaches the filesystem. `~` is legal in npm names but left out on purpose: the
// worker's filter-path check does not accept it, so such a name could never install.
export const NPM_PACKAGE_NAME_REGEX = /^(?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*$/

export const QadamPackageName = z.string().regex(NPM_PACKAGE_NAME_REGEX, formErrors.invalidQadamPackageName)

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
    release: PlatformReleaseType.optional(),
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
    release: PlatformReleaseType,
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
        qadamName: QadamPackageName,
        qadamVersion: ExactVersionType,
        qadamArchive: ApMultipartFile,
    }).describe('Private Qadam'),
    z.object({
        packageType: z.literal(PackageType.REGISTRY),
        scope: z.literal(QadamScope.PLATFORM),
        qadamName: QadamPackageName,
        qadamVersion: ExactVersionType,
    }).describe('NPM Qadam'),
])

export type AddQadamRequestBody = z.infer<typeof AddQadamRequestBody>

