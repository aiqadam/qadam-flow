// Thin CLI adapter over the library functions tools/ci/test-publish-workspace-invariants.sh
// exercises against synthetic fixtures. Not part of the publish pipeline itself — the real
// entry point is tools/scripts/publish-framework-packages.ts — this exists only because
// prepareQadamDistForPublish/assertNoUnresolvedWorkspaceDeps/assertNoSemverRanges have no CLI
// of their own to invoke against a fixture directory.
import { prepareQadamDistForPublish } from '../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { assertNoSemverRanges, assertNoUnresolvedWorkspaceDeps } from '../scripts/utils/publish-npm-package'

const [, , mode, arg] = process.argv

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
