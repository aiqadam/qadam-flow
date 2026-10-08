// Loads a built qadam artifact the way the platform would — `@aiqadam/*` and `zod` resolved
// upward from the artifact to the platform's single copy, never from inside it — and writes the
// artifact's `metadata.json` from what loaded. Generating the metadata from the artifact itself
// is the load check: an artifact whose `metadata.json` exists has loaded at least once (ADR-0003
// "Unavailable version": the prototype's `crypto` bundle built but did not load).
//
// The entry shape matches one element of the image's `bundled-qadams-metadata.json` without
// `directoryPath` (`loadQadamFromFolder` in `packages/server/api/.../file-qadams-utils.ts`):
// the qadam's `metadata()` plus `name`, `version`, `authors` and `i18n`.
//
// Usage: node extract-artifact-metadata-child.mjs <artifactDir>
// Prints one JSON summary line on stdout; exits non-zero with the reason on stderr.

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const artifactDir = process.argv[2] ? resolve(process.argv[2]) : null
if (artifactDir === null) {
    console.error('[extract-artifact-metadata] missing artifact directory argument')
    process.exit(2)
}

const artifactRequire = createRequire(join(artifactDir, 'package.json'))
const packageJson = artifactRequire('./package.json')
const module = artifactRequire('./src/index.js')

// By constructor name, as `load-qadam-metadata-child.mjs` and `extractQadamFromModule` do: the
// `Qadam` class is the platform's, and nothing here may import a second copy of it to compare.
const qadam = Object.values(module).find((exported) => exported?.constructor?.name === 'Qadam')
if (qadam === undefined) {
    console.error(`[extract-artifact-metadata] no Qadam export in ${packageJson.name}@${packageJson.version}`)
    process.exit(3)
}

const framework = artifactRequire('@aiqadam/qadams-framework')
const i18n = await framework.qadamTranslation.initializeI18n(artifactDir)
const metadata = {
    ...qadam.metadata(),
    name: packageJson.name,
    version: packageJson.version,
    authors: qadam.authors,
    i18n,
}
writeFileSync(join(artifactDir, 'metadata.json'), JSON.stringify(metadata))

const platformResolved = Object.fromEntries(['@aiqadam/qadams-framework', 'zod'].map((name) => [name, artifactRequire.resolve(name)]))
const insideArtifact = Object.entries(platformResolved).filter(([, path]) => path.startsWith(artifactDir))
if (insideArtifact.length > 0) {
    console.error(`[extract-artifact-metadata] platform packages resolved from inside the artifact: ${insideArtifact.map(([name]) => name).join(', ')}`)
    process.exit(4)
}

process.stdout.write(JSON.stringify({
    actions: Object.keys(metadata.actions ?? {}).length,
    triggers: Object.keys(metadata.triggers ?? {}).length,
    i18nLocales: Object.keys(i18n ?? {}).length,
    contextVersion: qadam.getContextInfo?.().version ?? null,
    minimumSupportedRelease: metadata.minimumSupportedRelease ?? null,
    metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
}) + '\n')
// A qadam may leave timers or sockets open at module load; the metadata is written, so stop here.
process.exit(0)
