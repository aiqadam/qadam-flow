import { createHash } from 'node:crypto'
import { QadamMetadata } from '@aiqadam/qadams-framework'
import { isNil, NPM_PACKAGE_NAME_REGEX } from '@aiqadam/shared'
import semVer from 'semver'
import { z } from 'zod'

// The qadam version catalogue (ADR-0003 "Catalogue", #778): static JSON describing every released
// version of every official qadam, with the integrity of the artifact that was released and the
// version's own `metadata.json` (#804). This file is its on-disk and on-the-wire format, shared by
// the writer (`qadam-version-catalogue-writer.ts`, run by the release pipeline) and the reader
// (`qadam-version-catalogue.ts`, run by the API) so the two cannot drift.
//
// Layout, relative to the catalogue root (`https://flow.aiqadam.org/catalog/v1/` by default):
//
//   index.json                                  every qadam, every version, and per version the
//                                               artifact's and the metadata file's sha512 integrity
//   qadams/<name>/<version>/metadata.json       the artifact's own `metadata.json`, byte for byte
//
// The `v1` in the URL is the schema's major. Inside it only additive changes are allowed: a new
// optional field, or a new value in an enum. A reader ignores fields it does not know and skips an
// entry it cannot parse, so a release keeps reading a catalogue that later releases append to. A
// change an older reader would misread is a new directory, `v2/`, and `v1/` stays published.
export const QADAM_VERSION_CATALOGUE_SCHEMA_VERSION = 1

export const QADAM_VERSION_CATALOGUE_DEFAULT_URL = 'https://flow.aiqadam.org/catalog/v1/'

export const QADAM_VERSION_CATALOGUE_INDEX_FILE = 'index.json'

// Bounds for what a reader accepts from a source it does not control (a mirror). The index grows
// by ~0.4 KB per released version; one version's metadata, i18n included, measured at most a few
// hundred KB on the 238 current versions.
export const QADAM_VERSION_CATALOGUE_MAX_INDEX_BYTES = 32 * 1024 * 1024
export const QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES = 16 * 1024 * 1024

export const QadamVersionCatalogueArtifactFormat = {
    // #804's artifact: one bundle, `@aiqadam/*` and `zod` provided by the platform.
    BUNDLE: 'bundle',
    // A `0.x` version as npm received it, before the qadam's `1.0.0` switched it to a bundle
    // (ADR-0003 "Qadams at 1.0.0"). The same two formats the version store reads (#805).
    LEGACY_NPM: 'legacy-npm',
} as const

export const QadamVersionCatalogueArtifactKind = {
    BUNDLE: 'bundle',
    BUNDLE_WITH_NODE_MODULES: 'bundle-with-node-modules',
} as const

const Sha512Integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
const ByteSize = z.number().int().nonnegative()
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/)

const BundleArtifact = z.object({
    format: z.literal(QadamVersionCatalogueArtifactFormat.BUNDLE),
    kind: z.enum([QadamVersionCatalogueArtifactKind.BUNDLE, QadamVersionCatalogueArtifactKind.BUNDLE_WITH_NODE_MODULES]),
    integrity: Sha512Integrity,
    size: ByteSize,
})

const LegacyNpmArtifact = z.object({
    format: z.literal(QadamVersionCatalogueArtifactFormat.LEGACY_NPM),
    integrity: Sha512Integrity,
    size: ByteSize,
})

const entryShape = {
    // The tarball that was released: the file npm serves and the image seeds into the store.
    artifact: z.discriminatedUnion('format', [BundleArtifact, LegacyNpmArtifact]),
    // `qadams/<name>/<version>/metadata.json`. The path is derived from the name and version, never
    // read from the index, so an index cannot point a reader anywhere else.
    metadata: z.object({
        integrity: Sha512Integrity,
        size: ByteSize,
    }),
    // Copied from the metadata, so a reader can filter by platform release (`isSupportedRelease`)
    // without fetching every version's metadata.
    minimumSupportedRelease: z.string().optional(),
    maximumSupportedRelease: z.string().optional(),
    // The commit the artifact was built from (#804's archive index).
    commit: CommitSha.optional(),
}

// Lenient: what a reader parses. Unknown fields are dropped, which is what lets a later release add one.
export const QadamVersionCatalogueEntry = z.object(entryShape)
export type QadamVersionCatalogueEntry = z.infer<typeof QadamVersionCatalogueEntry>

// Strict: what the writer accepts back before it appends. An old writer must not rewrite an index a
// newer writer produced, because it would silently drop every field it does not know.
const StrictEntry = z.strictObject({
    ...entryShape,
    artifact: z.discriminatedUnion('format', [BundleArtifact.strict(), LegacyNpmArtifact.strict()]),
    metadata: entryShape.metadata.strict(),
})

const IndexEnvelope = z.object({
    schemaVersion: z.number().int(),
    qadams: z.record(z.string(), z.object({
        versions: z.record(z.string(), z.unknown()),
    })),
})

const StrictIndex = z.strictObject({
    schemaVersion: z.literal(QADAM_VERSION_CATALOGUE_SCHEMA_VERSION),
    qadams: z.record(z.string(), z.strictObject({
        versions: z.record(z.string(), StrictEntry),
    })),
})

export const qadamVersionCatalogueFormat = {
    // Official qadams only: a custom qadam is never in the catalogue. Lower-case npm grammar, so the
    // name is also a safe pair of path segments (`@aiqadam`, `qadam-<x>`).
    isCatalogueName: (name: string): boolean => NPM_PACKAGE_NAME_REGEX.test(name) && name.startsWith(OFFICIAL_QADAM_NAME_PREFIX),

    // Canonical semver, no build metadata: `v1.0.0`, `1.0` and `1.0.0+x` are not versions here, and
    // a version is a single safe path segment.
    isCatalogueVersion: (version: string): boolean => semVer.valid(version) === version && !version.includes('+'),

    metadataPath: ({ name, version }: Coordinates): string => `qadams/${name}/${version}/metadata.json`,

    integrityOf: (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`,

    // For a reader: one bad entry is skipped and counted, never fatal, because it may be a format
    // or a field value a later release added. A wrong envelope or another schema version is.
    parseIndex: (value: unknown): ParseIndexResult => {
        const envelope = IndexEnvelope.safeParse(value)
        if (!envelope.success) {
            return { status: 'invalid' }
        }
        if (envelope.data.schemaVersion !== QADAM_VERSION_CATALOGUE_SCHEMA_VERSION) {
            return { status: 'unsupported', schemaVersion: envelope.data.schemaVersion }
        }
        const parsed = Object.entries(envelope.data.qadams).flatMap(([name, { versions }]) =>
            Object.entries(versions).map(([version, rawEntry]) => parseEntry({ name, version, rawEntry })),
        )
        const qadams = new Map<string, Map<string, QadamVersionCatalogueEntry>>()
        for (const item of parsed) {
            if (isNil(item)) {
                continue
            }
            const versions = qadams.get(item.name) ?? new Map<string, QadamVersionCatalogueEntry>()
            versions.set(item.version, item.entry)
            qadams.set(item.name, versions)
        }
        return { status: 'ok', qadams, skippedEntries: parsed.filter(isNil).length }
    },

    // For the writer: everything must parse, nothing unknown may be present.
    parseIndexStrict: (value: unknown): ParseIndexStrictResult => {
        const parsed = StrictIndex.safeParse(value)
        if (!parsed.success) {
            return { status: 'invalid', reason: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
        }
        const badCoordinates = Object.entries(parsed.data.qadams).flatMap(([name, { versions }]) =>
            Object.keys(versions).filter((version) => !qadamVersionCatalogueFormat.isCatalogueName(name) || !qadamVersionCatalogueFormat.isCatalogueVersion(version)).map((version) => `${name}@${version}`),
        )
        if (badCoordinates.length > 0) {
            return { status: 'invalid', reason: `not catalogue coordinates: ${badCoordinates.slice(0, 3).join(', ')}` }
        }
        const qadams = new Map(Object.entries(parsed.data.qadams).map(([name, { versions }]) => [name, new Map(Object.entries(versions))]))
        return { status: 'ok', qadams }
    },

    // Deterministic: names sorted, versions in semver order, fields in a fixed order. A re-run that
    // adds nothing produces the same bytes, so the published file only changes when a version is added.
    serializeIndex: ({ qadams }: { qadams: CatalogueEntries }): string => {
        const sortedNames = [...qadams.keys()].sort()
        const index = {
            schemaVersion: QADAM_VERSION_CATALOGUE_SCHEMA_VERSION,
            qadams: Object.fromEntries(sortedNames.map((name) => {
                const versions = qadams.get(name) ?? new Map<string, QadamVersionCatalogueEntry>()
                const sortedVersions = [...versions.keys()].sort(semVer.compare)
                return [name, { versions: Object.fromEntries(sortedVersions.map((version) => [version, orderEntryFields({ entry: versions.get(version) })])) }]
            })),
        }
        return JSON.stringify(index, null, 2) + '\n'
    },
}

// Only what this file and its callers rely on is checked; the rest is the qadam's own `metadata()`
// output, the same shape the image's bundled manifest and `qadam_metadata` carry. `z.custom` rather
// than `z.object`, because an object schema strips every key it does not list.
export const QadamVersionCatalogueMetadataFile = z.custom<QadamMetadata>(hasMetadataShape)

const OFFICIAL_QADAM_NAME_PREFIX = '@aiqadam/qadam-'

function parseEntry({ name, version, rawEntry }: { name: string, version: string, rawEntry: unknown }): ParsedEntry | null {
    if (!qadamVersionCatalogueFormat.isCatalogueName(name) || !qadamVersionCatalogueFormat.isCatalogueVersion(version)) {
        return null
    }
    const entry = QadamVersionCatalogueEntry.safeParse(rawEntry)
    return entry.success ? { name, version, entry: entry.data } : null
}

function orderEntryFields({ entry }: { entry: QadamVersionCatalogueEntry | undefined }): Record<string, unknown> {
    if (isNil(entry)) {
        return {}
    }
    const artifact = entry.artifact.format === QadamVersionCatalogueArtifactFormat.BUNDLE
        ? { format: entry.artifact.format, kind: entry.artifact.kind, integrity: entry.artifact.integrity, size: entry.artifact.size }
        : { format: entry.artifact.format, integrity: entry.artifact.integrity, size: entry.artifact.size }
    return {
        artifact,
        metadata: { integrity: entry.metadata.integrity, size: entry.metadata.size },
        ...(isNil(entry.minimumSupportedRelease) ? {} : { minimumSupportedRelease: entry.minimumSupportedRelease }),
        ...(isNil(entry.maximumSupportedRelease) ? {} : { maximumSupportedRelease: entry.maximumSupportedRelease }),
        ...(isNil(entry.commit) ? {} : { commit: entry.commit }),
    }
}

function hasMetadataShape(value: unknown): boolean {
    if (typeof value !== 'object' || isNil(value) || Array.isArray(value)) {
        return false
    }
    const fields: Record<string, unknown> = { ...value }
    return typeof fields.name === 'string'
        && typeof fields.version === 'string'
        && typeof fields.displayName === 'string'
        && isPlainObject(fields.actions)
        && isPlainObject(fields.triggers)
        && isOptionalString(fields.minimumSupportedRelease)
        && isOptionalString(fields.maximumSupportedRelease)
}

function isPlainObject(value: unknown): boolean {
    return typeof value === 'object' && !isNil(value) && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
    return isNil(value) || typeof value === 'string'
}

type Coordinates = {
    name: string
    version: string
}

type ParsedEntry = Coordinates & {
    entry: QadamVersionCatalogueEntry
}

export type CatalogueEntries = Map<string, Map<string, QadamVersionCatalogueEntry>>

export type ParseIndexResult =
    | { status: 'ok', qadams: CatalogueEntries, skippedEntries: number }
    | { status: 'invalid' }
    | { status: 'unsupported', schemaVersion: number }

export type ParseIndexStrictResult =
    | { status: 'ok', qadams: CatalogueEntries }
    | { status: 'invalid', reason: string }
