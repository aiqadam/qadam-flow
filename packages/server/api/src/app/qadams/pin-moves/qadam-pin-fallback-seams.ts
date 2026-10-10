import { ImageBuild, PinMetadata, PropsCompatibilityChecker } from '@aiqadam/server-utils'
import { isNil, PlatformId, qadamVersionParser, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { findImageBuild, loadBundledQadams } from '../metadata/utils'
import { qadamPropsCompatibility } from '../snapshot-export/qadam-props-compatibility'
import { SnapshotExportSources, snapshotExportSources } from '../snapshot-export/snapshot-export-sources'

// What `qadamPinMoveService` needs from outside the decision, each a named seam so the service and
// its tests do not know where the answer comes from.
export const qadamPinFallbackSeams = ({ log, sources = snapshotExportSources.forInstance({ log }) }: { log: FastifyBaseLogger, sources?: SnapshotExportSources }): PinFallbackSeams => ({
    // What the image ships for a qadam name. The loaded list holds only builds whose module loaded:
    // the image-build manifest writer refuses a catalogue with a qadam that failed to load
    // (`bundledQadamsManifest`), and the scan skips one with a warning (`loadDistFoldersMetadata`).
    // So "the image ships it" is the load check ADR-0003 asks for, which catches a bundle that
    // cannot be loaded at all (the prototype's `crypto`, `import.meta` in CJS). It does not run an
    // action: that is the audit record's revert (activepieces#15957).
    imageBuild: async ({ name, platformId }) => {
        const bundled = findImageBuild({ bundled: await loadBundledQadams(log), name, platformId })
        return isNil(bundled) ? null : { build: { version: bundled.version, load: { loaded: true } }, metadata: bundled }
    },

    // What the instance knows about the pinned version (ADR-0003, ADR-0004), through the sources
    // #880's export reads: a release's `metadata.json` from the catalogue, a snapshot's from the
    // store. The catalogue's default address answers 404 until #778 publishes it, and then every
    // release pin is `unknown` and stays put: that is the intended fail-closed answer. Only a
    // catalogue that was read and does not list the version says "never published".
    pinMetadata: async ({ name, version }) => {
        const { data, error } = await tryCatch(() => readPinMetadata({ sources, name, version }))
        return isNil(error) && !isNil(data) ? data : { status: 'unknown' }
    },

    // ADR-0001 gate 2's schema diff, #880's checker. Nothing here compares props itself.
    propsChecker: qadamPropsCompatibility,
})

async function readPinMetadata({ sources, name, version }: { sources: SnapshotExportSources, name: string, version: string }): Promise<PinMetadata> {
    if (qadamVersionParser.isSnapshot({ version })) {
        const metadata = await sources.snapshotMetadata({ name, version })
        return isNil(metadata) ? { status: 'unknown' } : { status: 'found', metadata }
    }
    const releases = await sources.releases({ name })
    if (isNil(releases)) {
        return { status: 'unknown' }
    }
    if (!releases.includes(version)) {
        return { status: 'never-published' }
    }
    const metadata = await sources.releaseMetadata({ name, version })
    return isNil(metadata) ? { status: 'unknown' } : { status: 'found', metadata }
}

export type PinFallbackSeams = {
    imageBuild: (params: { name: string, platformId: PlatformId }) => Promise<ImageBuildWithMetadata | null>
    pinMetadata: (params: { name: string, version: string }) => Promise<PinMetadata>
    propsChecker: PropsCompatibilityChecker
}

export type ImageBuildWithMetadata = {
    build: ImageBuild
    metadata: unknown
}
