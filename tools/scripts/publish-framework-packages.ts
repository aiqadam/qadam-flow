import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishNpmPackage } from './utils/publish-npm-package'

// Every qadam depends on these three through the bun workspace protocol
// (`"@aiqadam/shared": "workspace:*"`, etc. — see #475), so they are step 1a of the
// version-model decision in #433 and must publish before any qadam (#476, step 1b) can.
// `framework` and `common` themselves depend on `shared` (`common` on both), so the order
// below is the dependency order — not load-bearing for `npm publish` itself (it uploads
// whatever version each package.json declares without resolving it), but it means a
// registry client racing the tail of the publish never observes a dependent published ahead
// of what it depends on.
const FRAMEWORK_PACKAGE_PATHS = [
  'packages/shared',
  'packages/qadams/framework',
  'packages/qadams/common',
]

// The name tools/ci/publish-packed-tarballs.sh reads. Since #486 split packing from
// publishing, this ORDER no longer survives implicitly: the publishing job sees a directory
// of tarballs, and `*.tgz` glob order is alphabetical — `aiqadam-qadams-common` sorts ahead
// of `aiqadam-shared`, i.e. exactly backwards from the dependency order above. The manifest
// is what carries the order across the job boundary.
//
// Not exported: the consumer is a shell script, which cannot import it and hardcodes the same
// literal. tools/ci/test-publish-packed-tarballs.sh asserts the two spellings agree, so the
// duplication cannot drift silently.
const PUBLISH_ORDER_FILENAME = 'publish-order.txt'

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes('--dry-run')
  // Keyed on the flag being PRESENT, not on it yielding a value. `--pack-to` with no `=`, or
  // `--pack-to=` with nothing after it, would otherwise leave packDestination falsy and fall
  // straight through to a real `npm publish` — on the one command in this repo that has no
  // undo, and the two likeliest ways to mistype it. CI never hits this (release.yml always
  // interpolates a non-empty runner.temp path) and the pack job holds no credential, but that
  // makes "pack never publishes" a property of the secret being absent rather than an
  // assertion, which is not where it belongs. `slice`, not `split('=')[1]`, so a destination
  // containing an `=` is not silently truncated.
  const packToArg = process.argv.find((arg) => arg === '--pack-to' || arg.startsWith('--pack-to='))
  const packDestination = packToArg?.startsWith('--pack-to=') === true ? packToArg.slice('--pack-to='.length) : undefined
  if (packToArg !== undefined && (packDestination === undefined || packDestination.length === 0)) {
    throw new Error('[publishFrameworkPackages] --pack-to requires a destination: --pack-to=<dir>. Refusing to fall through to a real publish.')
  }
  // release.yml no longer sets this: the job is skipped entirely for a prerelease ref (see its
  // header comment), so every real run here is a stable tag and always publishes to `latest`.
  // Left overridable for manual/local use — `publishNpmPackage` normalizes an unset or empty
  // value to `latest` on its own.
  const npmDistTag = process.env['NPM_DIST_TAG']
  // See PublishNpmPackageParams.skipRegistryCheck. publishNpmPackage refuses this unless the run
  // also packs, so it cannot be used to force a publish past the already-published guard.
  const skipRegistryCheck = process.argv.includes('--skip-registry-check')

  const packedFilenames: string[] = []
  for (const path of FRAMEWORK_PACKAGE_PATHS) {
    const result = await publishNpmPackage({ path, dryRun, npmDistTag, packDestination, skipRegistryCheck })
    if (result.status === 'packed' && packDestination) {
      packedFilenames.push(result.filename)
    }
  }

  if (packDestination) {
    // Written even when empty — all three already published at their current version is a
    // normal, green outcome, and the publishing job has to be able to tell it apart from an
    // artifact that failed to upload. A missing manifest is an error there; an empty one is not.
    writeFileSync(join(packDestination, PUBLISH_ORDER_FILENAME), packedFilenames.map((name) => `${name}\n`).join(''))
    console.info(`[publishFrameworkPackages] wrote ${PUBLISH_ORDER_FILENAME} with ${packedFilenames.length} entries`)
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
