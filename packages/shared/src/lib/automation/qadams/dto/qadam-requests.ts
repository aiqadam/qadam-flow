import { z } from 'zod'
import { ApMultipartFile } from '../../../core/common'
import { OptionalArrayFromQuery, OptionalBooleanFromQuery } from '../../../core/common/base-model'
import { formErrors } from '../../../form-errors'
import { PackageType, QadamCategory } from '../qadam'
import { QADAM_PIN_PATTERN, QADAM_RELEASE_PATTERN, QADAM_VERSION_PATTERN } from '../qadam-version'

// One grammar for every version a qadam request or a stored step carries (ADR-0004): see
// `qadamVersionParser`. A pin may lead with `^` or `~`.
export const VersionType = z.string().regex(new RegExp(QADAM_PIN_PATTERN))

// What a custom qadam is installed at. A `-main.<n>` number names an official snapshot only.
export const ReleaseVersionType = z.string().regex(new RegExp(QADAM_RELEASE_PATTERN))

// The platform version as `apVersionUtil.getCurrentRelease()` reports it: a release, or
// `<next>-main.<n>` on images built from `main` (ADR-0001, #798).
const PlatformReleaseType = z.string().regex(new RegExp(QADAM_VERSION_PATTERN))

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
        qadamVersion: ReleaseVersionType,
        qadamArchive: ApMultipartFile,
    }).describe('Private Qadam'),
    z.object({
        packageType: z.literal(PackageType.REGISTRY),
        scope: z.literal(QadamScope.PLATFORM),
        qadamName: QadamPackageName,
        qadamVersion: ReleaseVersionType,
    }).describe('NPM Qadam'),
])

export type AddQadamRequestBody = z.infer<typeof AddQadamRequestBody>

