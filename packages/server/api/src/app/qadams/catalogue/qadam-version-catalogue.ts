import { QadamMetadata } from '@aiqadam/qadams-framework'
import { isNil, tryCatchSync } from '@aiqadam/shared'
import semVer from 'semver'
import {
    CatalogueEntries,
    QADAM_VERSION_CATALOGUE_INDEX_FILE,
    QADAM_VERSION_CATALOGUE_MAX_INDEX_BYTES,
    QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES,
    QadamVersionCatalogueEntry,
    qadamVersionCatalogueFormat,
} from './qadam-version-catalogue-format'
import { QadamVersionCatalogueSource } from './qadam-version-catalogue-source'

// How the API reads the qadam version catalogue (ADR-0003, #778). Nothing calls it yet: wiring it
// into metadata resolution, the unavailable-version fallback and the image snapshot is #806, #807
// and #808 (see `.agents/features/qadam-version-catalogue.md`). It never throws; every outcome is a
// status, so a caller can fall back when the catalogue host is unreachable.
//
// What it guarantees:
// - the index is a schema-1 catalogue; an entry it cannot parse (a field value a later release
//   added, or a broken one) is skipped and counted, never fatal;
// - a version's metadata is exactly the bytes the index's integrity names, is a qadam metadata
//   object, and names the requested qadam and version.
// What it does not: the index itself is trusted as far as its source is (HTTPS to the configured
// host, or the image's own snapshot). The integrity of an `@aiqadam/*` tarball is checked again by
// its npm signature when it is fetched (#806), which does not depend on the catalogue.
export const qadamVersionCatalogue = {
    read: async ({ source }: { source: QadamVersionCatalogueSource }): Promise<ReadCatalogueResult> => {
        const fetched = await source.read({ relativePath: QADAM_VERSION_CATALOGUE_INDEX_FILE, maxBytes: QADAM_VERSION_CATALOGUE_MAX_INDEX_BYTES })
        if (fetched.status !== 'ok') {
            return { status: 'unavailable', reason: fetched.status === 'not-found' ? 'no index' : fetched.reason }
        }
        const { data: json, error } = tryCatchSync((): unknown => JSON.parse(fetched.bytes.toString('utf8')))
        if (error) {
            return { status: 'invalid', reason: 'index is not JSON' }
        }
        const parsed = qadamVersionCatalogueFormat.parseIndex(json)
        switch (parsed.status) {
            case 'invalid':
                return { status: 'invalid', reason: 'index is not a qadam version catalogue' }
            case 'unsupported':
                return { status: 'unsupported', schemaVersion: parsed.schemaVersion }
            case 'ok':
                return { status: 'ok', catalogue: buildCatalogue({ source, qadams: parsed.qadams }), skippedEntries: parsed.skippedEntries }
        }
    },
}

function buildCatalogue({ source, qadams }: { source: QadamVersionCatalogueSource, qadams: CatalogueEntries }): QadamVersionCatalogue {
    const entry = ({ name, version }: Coordinates): QadamVersionCatalogueEntry | undefined => qadams.get(name)?.get(version)
    return {
        names: () => [...qadams.keys()].sort(),
        versions: ({ name }) => [...(qadams.get(name)?.keys() ?? [])].sort(semVer.compare),
        entry,
        readMetadata: async ({ name, version }): Promise<ReadMetadataResult> => {
            const found = entry({ name, version })
            if (isNil(found)) {
                return { status: 'not-in-catalogue' }
            }
            const fetched = await source.read({
                relativePath: qadamVersionCatalogueFormat.metadataPath({ name, version }),
                maxBytes: QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES,
            })
            if (fetched.status !== 'ok') {
                return { status: 'unavailable', reason: fetched.status === 'not-found' ? 'no metadata file' : fetched.reason }
            }
            const checked = qadamVersionCatalogueFormat.checkMetadataFile({ bytes: fetched.bytes, name, version, expected: found.metadata })
            switch (checked.status) {
                case 'ok':
                    return { status: 'ok', metadata: checked.metadata }
                case 'integrity-mismatch':
                    return { status: 'integrity-mismatch' }
                case 'not-json':
                    return { status: 'invalid', reason: 'metadata is not JSON' }
                case 'not-qadam-metadata':
                    return { status: 'invalid', reason: 'not qadam metadata' }
                case 'other-version':
                    return { status: 'invalid', reason: 'metadata names another qadam version' }
            }
        },
    }
}

type Coordinates = {
    name: string
    version: string
}

export type QadamVersionCatalogue = {
    names: () => string[]
    // Ascending semver order.
    versions: (params: { name: string }) => string[]
    entry: (params: Coordinates) => QadamVersionCatalogueEntry | undefined
    readMetadata: (params: Coordinates) => Promise<ReadMetadataResult>
}

export type ReadCatalogueResult =
    | { status: 'ok', catalogue: QadamVersionCatalogue, skippedEntries: number }
    | { status: 'unavailable', reason: string }
    | { status: 'invalid', reason: string }
    | { status: 'unsupported', schemaVersion: number }

export type ReadMetadataResult =
    | { status: 'ok', metadata: QadamMetadata }
    | { status: 'not-in-catalogue' }
    | { status: 'unavailable', reason: string }
    | { status: 'integrity-mismatch' }
    | { status: 'invalid', reason: string }
