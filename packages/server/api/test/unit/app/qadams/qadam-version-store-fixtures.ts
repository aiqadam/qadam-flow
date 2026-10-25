import { mkdir } from 'node:fs/promises'
import { qadamVersionStore, qadamVersionStoreSeed } from '@aiqadam/server-utils'
import { catalogueFixtures, FixtureArtifact } from './qadam-version-catalogue-fixtures'

// Writes a store the way an image seeds it: #804-shaped tarballs in an archive, read by the real
// store writer. A test that needs a version only the store holds gets it here, not by hand-writing
// an `integrity.json`.
export const qadamVersionStoreFixtures = {
    seed: async ({ root, seedDir, artifacts }: SeedParams): Promise<void> => {
        await catalogueFixtures.writeArchive({ archiveDir: seedDir, artifacts })
        await mkdir(root, { recursive: true })
        const log = { info: (): void => undefined, warn: (): void => undefined }
        const opened = await qadamVersionStore.open({ root, log })
        if (!opened.ok) {
            throw new Error(opened.reason)
        }
        const report = await qadamVersionStoreSeed.seedFromImage({ store: opened.store, seedDir, log })
        if (report.failed.length > 0) {
            throw new Error(`store seed failed: ${report.failed.map((failure) => failure.qadam).join(', ')}`)
        }
    },

    artifact: ({ name, version, overrides }: ArtifactParams): FixtureArtifact => ({
        name,
        version,
        metadata: catalogueFixtures.metadata({ name, version, overrides }),
    }),
}

type SeedParams = {
    root: string
    seedDir: string
    artifacts: FixtureArtifact[]
}

type ArtifactParams = {
    name: string
    version: string
    overrides?: Record<string, unknown>
}
