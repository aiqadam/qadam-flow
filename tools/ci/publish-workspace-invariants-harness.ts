// Thin CLI adapter over the library functions tools/ci/test-publish-workspace-invariants.sh
// exercises against synthetic fixtures. Not part of the publish pipeline itself — the real
// entry point is tools/scripts/publish-framework-packages.ts — this exists only because
// prepareQadamDistForPublish/assertNoUnresolvedWorkspaceDeps/assertNoSemverRanges/
// stagePackageForPublish have no CLI of their own to invoke against a fixture directory.
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { prepareQadamDistForPublish } from '../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { assertNoSemverRanges, assertNoUnresolvedWorkspaceDeps } from '../scripts/utils/publish-npm-package'
import { stagePackageForPublish } from '../scripts/utils/stage-package-for-publish'

const [, , mode, arg, bundled] = process.argv

const run = async (): Promise<void> => {
  switch (mode) {
    case 'prepare':
      prepareQadamDistForPublish(arg)
      return
    case 'assert-no-workspace-deps':
      assertNoUnresolvedWorkspaceDeps(arg)
      return
    case 'assert-no-semver-ranges':
      assertNoSemverRanges(arg)
      return
    case 'stage': {
      // The staging directory is removed once `use` returns, so its contents are copied out for the
      // suite to inspect. STAGED names the directory that was packed, so the suite can check both
      // that it was a separate copy and that it no longer exists.
      const inspect = join(cwd(), 'staged-copy')
      const staged = await stagePackageForPublish({
        outputPath: arg,
        workspaceRoot: cwd(),
        bundledPrivateDependencies: bundled === undefined ? {} : JSON.parse(bundled),
        use: (publishRoot) => {
          cpSync(publishRoot, inspect, { recursive: true })
          return publishRoot
        },
      })
      console.log('STAGED ' + staged)
      console.log('INSPECT ' + inspect)
      return
    }
    default:
      throw new Error(`[publish-workspace-invariants-harness] unknown mode: ${mode}`)
  }
}

run().then(() => {
  console.log('OK')
}).catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
