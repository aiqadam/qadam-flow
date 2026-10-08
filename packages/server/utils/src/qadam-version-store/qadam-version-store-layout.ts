import path from 'node:path'
import { isNil, NPM_PACKAGE_NAME_REGEX } from '@aiqadam/shared'
import semver from 'semver'

// The on-disk format of the qadam version store (ADR-0003 "Store"). Later releases must read it,
// so every name here is part of a format, not a detail:
//
//   <root>/qadams/<name>/<version>/                          official qadams (`@aiqadam/qadam-*`)
//   <root>/qadams/_platform/<platformId>/<name>/<version>/   custom qadams of one platform
//   <root>/qadams/node_modules/                              reserved for the libraries the platform
//                                                            provides (`@aiqadam/*`, `zod`); a version
//                                                            resolves them upward from its own
//                                                            directory, never from inside itself (#779)
//   <root>/.staging/<ms>-<uuid>/                             a version being written, renamed into place
//   <root>/.trash/<ms>-<uuid>/                               a damaged version moved aside, then removed
//
// A version directory holds the artifact (`package.json`, its entry point, and for some formats
// `node_modules`), `metadata.json`, and `integrity.json`, which the store writes last.
//
// No npm package name can collide with a reserved directory: a name starts with `@` or
// `[a-z0-9-]`, so `_platform` and dot-directories are never a qadam, and `node_modules` is
// refused as a name segment below.
export const QADAM_VERSION_STORE_LAYOUT = {
    qadamsDir: 'qadams',
    platformNamespaceDir: '_platform',
    platformModulesDir: 'node_modules',
    stagingDir: '.staging',
    trashDir: '.trash',
    integrityFile: 'integrity.json',
    metadataFile: 'metadata.json',
    packageJsonFile: 'package.json',
} as const

export const qadamVersionStoreLayout = {
    validateCoordinates: ({ platformId, name, version }: QadamVersionCoordinates): CoordinatesValidation => {
        const nameProblem = describeNameProblem({ name })
        if (!isNil(nameProblem)) {
            return { valid: false, reason: nameProblem }
        }
        const versionProblem = describeVersionProblem({ version })
        if (!isNil(versionProblem)) {
            return { valid: false, reason: versionProblem }
        }
        if (isNil(platformId)) {
            return name.startsWith(OFFICIAL_QADAM_NAME_PREFIX)
                ? { valid: true }
                : { valid: false, reason: `only official qadams (${OFFICIAL_QADAM_NAME_PREFIX}*) live outside a platform namespace` }
        }
        if (!PLATFORM_ID_PATTERN.test(platformId)) {
            return { valid: false, reason: 'platform id is not a valid id' }
        }
        // Mirrors `qadamMetadataService.create` (#503): a platform cannot register a qadam under the
        // official scope, so its namespace never holds one either.
        return name.toLowerCase().startsWith(OFFICIAL_SCOPE_PREFIX)
            ? { valid: false, reason: `a platform namespace cannot hold a qadam in the ${OFFICIAL_SCOPE_PREFIX} scope` }
            : { valid: true }
    },

    namespaceDir: ({ root, platformId }: NamespaceDirParams): string => {
        const qadamsDir = path.join(root, QADAM_VERSION_STORE_LAYOUT.qadamsDir)
        if (isNil(platformId)) {
            return qadamsDir
        }
        if (!PLATFORM_ID_PATTERN.test(platformId)) {
            throw new Error('platform id is not a valid id')
        }
        return path.join(qadamsDir, QADAM_VERSION_STORE_LAYOUT.platformNamespaceDir, platformId)
    },

    // Throws on coordinates `validateCoordinates` refuses: a caller must validate first, and a path
    // is never built from anything that was not.
    versionDir: ({ root, coordinates }: VersionDirParams): string => {
        const validation = qadamVersionStoreLayout.validateCoordinates(coordinates)
        if (!validation.valid) {
            throw new Error(`invalid qadam version coordinates: ${validation.reason}`)
        }
        const namespaceDir = qadamVersionStoreLayout.namespaceDir({ root, platformId: coordinates.platformId })
        const dir = path.join(namespaceDir, ...coordinates.name.split('/'), coordinates.version)
        // Defence in depth: the validation above already excludes every way out of the namespace.
        const relative = path.relative(namespaceDir, dir)
        if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
            throw new Error('qadam version path escapes its namespace')
        }
        return dir
    },

    isReservedNamespaceEntry: ({ entryName }: { entryName: string }): boolean => {
        return entryName.startsWith('.') || entryName.startsWith('_') || entryName === QADAM_VERSION_STORE_LAYOUT.platformModulesDir
    },
}

const OFFICIAL_SCOPE_PREFIX = '@aiqadam/'
const OFFICIAL_QADAM_NAME_PREFIX = '@aiqadam/qadam-'
// npm's own limit on a package name.
const MAX_NAME_LENGTH = 214
const MAX_VERSION_LENGTH = 64
// `ApId` in `@aiqadam/shared`: 21 characters of [0-9a-zA-Z].
const PLATFORM_ID_PATTERN = /^[0-9a-zA-Z]{21}$/
// What remains of a canonical semver once build metadata is refused: a version directory name is
// then exactly the version npm and the flow pin carry.
const VERSION_CHARACTERS = /^[0-9A-Za-z.-]+$/

function describeNameProblem({ name }: { name: string }): string | null {
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        return 'qadam name is empty or too long'
    }
    if (!NPM_PACKAGE_NAME_REGEX.test(name)) {
        return 'qadam name is not a valid npm package name'
    }
    if (name.split('/').some((segment) => segment === QADAM_VERSION_STORE_LAYOUT.platformModulesDir || segment === '@')) {
        return 'qadam name uses a reserved path segment'
    }
    return null
}

function describeVersionProblem({ version }: { version: string }): string | null {
    if (version.length === 0 || version.length > MAX_VERSION_LENGTH || !VERSION_CHARACTERS.test(version)) {
        return 'qadam version is not a valid semver version'
    }
    // Canonical only: `v1.0.0` or `=1.0.0` would be a second directory for the same version.
    if (semver.valid(version) !== version) {
        return 'qadam version is not a canonical semver version'
    }
    return null
}

export type QadamVersionCoordinates = {
    // `null` is the official namespace, as on `qadam_metadata.platformId`. Required on purpose, so no
    // caller reaches a namespace by forgetting to name one.
    platformId: string | null
    name: string
    version: string
}

type CoordinatesValidation = { valid: true } | { valid: false, reason: string }

type NamespaceDirParams = {
    root: string
    platformId: string | null
}

type VersionDirParams = {
    root: string
    coordinates: QadamVersionCoordinates
}
