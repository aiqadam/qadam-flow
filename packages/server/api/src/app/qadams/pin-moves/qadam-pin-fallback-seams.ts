import { apVersionUtil, ImageBuild, PropsCompatibilityChecker } from '@aiqadam/server-utils'
import { isNil, PlatformId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { qadamPropsCompatibility } from '../snapshot-export/qadam-props-compatibility'
import { filterQadamBasedOnType, isSupportedRelease, loadBundledQadams } from '../metadata/utils'

// What `qadamPinMoveService` needs from outside the decision, each a named seam so the service and
// its tests do not know where the answer comes from.
export const qadamPinFallbackSeams = (log: FastifyBaseLogger): PinFallbackSeams => ({
    // What the image ships for a qadam name. The loaded list holds only builds whose module loaded:
    // the image-build manifest writer refuses a catalogue with a qadam that failed to load
    // (`bundledQadamsManifest`), and the scan skips one with a warning (`loadDistFoldersMetadata`).
    // So "the image ships it" is the load check ADR-0003 asks for, which catches a bundle that
    // cannot be loaded at all (the prototype's `crypto`, `import.meta` in CJS). It does not run an
    // action: that is the audit record's revert (activepieces#15957).
    imageBuild: async ({ name, platformId }) => {
        const bundled = (await loadBundledQadams(log)).find((qadam) => qadam.name === name)
        if (isNil(bundled) || !filterQadamBasedOnType(platformId, bundled) || !isSupportedRelease(apVersionUtil.getCurrentRelease(), bundled)) {
            return null
        }
        return { build: { version: bundled.version, load: { loaded: true } }, metadata: bundled }
    },

    // `metadata.json` of a version the instance may not hold: the catalogue's (ADR-0003) or a
    // snapshot's own (ADR-0004). Nothing at run time reads the catalogue yet (#806, #807), so it
    // answers null, which the decision reads as "no metadata": a release pin gets the load check
    // only, a snapshot pin is not moved.
    pinMetadata: async () => null,

    // ADR-0001 gate 2's schema diff, #880's checker. Nothing here compares props itself.
    propsChecker: qadamPropsCompatibility,
})

export type PinFallbackSeams = {
    imageBuild: (params: { name: string, platformId: PlatformId }) => Promise<ImageBuildWithMetadata | null>
    // The pinned version's own metadata, or null when there is none to read.
    pinMetadata: (params: { name: string, version: string }) => Promise<unknown>
    propsChecker: PropsCompatibilityChecker
}

export type ImageBuildWithMetadata = {
    build: ImageBuild
    metadata: unknown
}
