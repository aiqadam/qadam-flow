// Thin CLI adapter over the library functions tools/ci/test-publish-workspace-invariants.sh
// exercises against synthetic fixtures. Not part of the publish pipeline itself — the real
// entry point is tools/scripts/publish-framework-packages.ts — this exists only because
// prepareQadamDistForPublish/assertNoUnresolvedWorkspaceDeps/assertNoSemverRanges/
// stagePackageForPublish have no CLI of their own to invoke against a fixture directory.
import { prepareQadamDistForPublish } from '../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { cwd } from 'node:process'
import { assertNoSemverRanges, assertNoUnresolvedWorkspaceDeps } from '../scripts/utils/publish-npm-package'
import { stagePackageForPublish } from '../scripts/utils/stage-package-for-publish'

const [, , mode, arg, bundled] = process.argv

const run = (): void => {
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
    case 'stage':
      // Prints the directory that would be packed, so the suite can inspect it.
      console.log('STAGED ' + stagePackageForPublish({ outputPath: arg, workspaceRoot: cwd(), bundledPrivateDependencies: bundled === undefined ? {} : JSON.parse(bundled) }))
      return
    default:
      throw new Error(`[publish-workspace-invariants-harness] unknown mode: ${mode}`)
  }
}

try {
  run()
  console.log('OK')
} catch (err: unknown) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
