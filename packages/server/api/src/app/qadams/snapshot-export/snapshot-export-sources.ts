import { qadamVersionStoreReader } from '@aiqadam/server-utils'
import { tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { QadamVersionCatalogue, qadamVersionCatalogue } from '../catalogue/qadam-version-catalogue'
import { QADAM_VERSION_CATALOGUE_DEFAULT_URL, QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES } from '../catalogue/qadam-version-catalogue-format'
import { QadamVersionCatalogueSource, qadamVersionCatalogueSource } from '../catalogue/qadam-version-catalogue-source'

// Everything an export needs to know that is not in the flow: which releases of a qadam exist and
// what they describe, and what a snapshot this instance runs describes. The seam ADR-0004 names:
// "the released versions and metadata come from the catalogue (#778, wired at run time)". The
// catalogue's reader exists but nothing at run time uses it yet, so the instance binding below is
// the one place that fetches it; #806-#808 replace it with the store-and-catalogue resolution, and
// the export rule is unchanged.
//
// Every method answers "unknown" (`[]` or `null`) rather than throwing, and an export treats
// unknown as "no release passes": a pin is never moved on information the instance does not have.
export const snapshotExportSources = {
    forInstance: ({ log, catalogueSource = defaultCatalogueSource() }: ForInstanceParams): SnapshotExportSources => {
        // One catalogue read per export, however many pins it resolves.
        let catalogue: Promise<QadamVersionCatalogue | null> | undefined
        const readCatalogue = (): Promise<QadamVersionCatalogue | null> => {
            catalogue ??= loadCatalogue({ source: catalogueSource, log })
            return catalogue
        }
        return {
            releases: async ({ name }) => (await readCatalogue())?.versions({ name }) ?? [],
            releaseMetadata: async ({ name, version }) => {
                const result = await (await readCatalogue())?.readMetadata({ name, version })
                return result?.status === 'ok' ? result.metadata : null
            },
            snapshotMetadata: ({ name, version }) => readStoredMetadata({ name, version, log }),
        }
    },
}

async function loadCatalogue({ source, log }: { source: QadamVersionCatalogueSource, log: FastifyBaseLogger }): Promise<QadamVersionCatalogue | null> {
    const result = await qadamVersionCatalogue.read({ source })
    if (result.status === 'ok') {
        return result.catalogue
    }
    log.warn({ status: result.status }, '[snapshotExport] The qadam version catalogue is unavailable; snapshot pins in this export cannot be moved to a release')
    return null
}

// Read-only, bounded and symlink-safe: the store's own reader finds the version, and the catalogue's
// directory source reads `metadata.json` out of it.
async function readStoredMetadata({ name, version, log }: { name: string, version: string, log: FastifyBaseLogger }): Promise<unknown> {
    const opened = await qadamVersionStoreReader.open({ root: system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH) })
    if (!opened.ok) {
        log.debug({ reason: opened.reason }, '[snapshotExport] The qadam version store cannot be read')
        return null
    }
    const stored = await opened.reader.read({ coordinates: { platformId: null, name, version } })
    if (stored.status !== 'present') {
        return null
    }
    const file = await qadamVersionCatalogueSource.directory({ root: stored.version.dir }).read({ relativePath: 'metadata.json', maxBytes: QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES })
    if (file.status !== 'ok') {
        return null
    }
    return tryCatchSync((): unknown => JSON.parse(file.bytes.toString('utf8'))).data
}

function defaultCatalogueSource(): QadamVersionCatalogueSource {
    return qadamVersionCatalogueSource.http({ baseUrl: QADAM_VERSION_CATALOGUE_DEFAULT_URL })
}

type ForInstanceParams = {
    log: FastifyBaseLogger
    // Replaced by a mirror's source or a fake in tests.
    catalogueSource?: QadamVersionCatalogueSource
}

export type SnapshotExportSources = {
    // Released versions of an official qadam, in no particular order; `[]` when unknown.
    releases: (params: { name: string }) => Promise<string[]>
    // The release's own `metadata.json`; `null` when unknown.
    releaseMetadata: (params: { name: string, version: string }) => Promise<unknown>
    // The `metadata.json` of a snapshot this instance holds; `null` when it holds none.
    snapshotMetadata: (params: { name: string, version: string }) => Promise<unknown>
}
