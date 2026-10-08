// Drives tools/scripts/utils/package-pre-publish-checks.ts (ADR-0001 gate 3) against the stub
// registry tools/ci/test-registry-version-gate.sh starts. Prints `published` / `unpublished`, or
// `error: <message>` with exit 1 — the three outcomes the publish path distinguishes.
import { packagePrePublishChecks } from '../scripts/utils/package-pre-publish-checks'

const [path, registryUrl] = process.argv.slice(2)

packagePrePublishChecks({ path, registryUrl, maxAttempts: 3, retryBaseMs: 10 })
  .then((published) => {
    console.log(published ? 'published' : 'unpublished')
  })
  .catch((error: unknown) => {
    console.log(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
