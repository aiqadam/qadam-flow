import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishNpmPackage } from './utils/publish-npm-package'
import { findOfficialQadamPackagePaths } from './utils/qadam-publish-paths'
import { chunk } from '../../packages/shared/src/lib/core/common/utils/utils'

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

// Step 1b (#476) adds 238 more packages behind `--include-qadams`, and every one of them costs a
// serial `registry.npmjs.org/<pkg>/latest` round trip in packagePrePublishChecks before it can be
// packed. Serially that is the dominant cost of the pack job; unbounded it is 238 concurrent
// requests, which invites the 429 that `getLatestPublishedVersion`'s 4^n backoff turns into
// minutes of sleeping. 16 is chosen to keep the registry leg busy without looking like a burst —
// the pre-#486 script this replaces used 30-wide chunks with a 5s sleep between them, which is
// the same trade made less precisely.
//
// Bounded concurrency is safe here in a way it would not be at publish time: the 238 qadams
// depend only on the three framework packages and on none of each other (checked across all 238
// manifests), so nothing in this set has an ordering constraint against anything else in it.
const QADAM_PACK_CONCURRENCY = 16

// Returns the packed filenames rather than appending to a list the caller owns: the manifest is
// written once, from one array, in one place, so there is no window in which a partially
// appended manifest could be observed or written out.
const packOfficialQadams = async ({ dryRun, npmDistTag, packDestination, skipRegistryCheck }: PackOfficialQadamsParams): Promise<string[]> => {
  const qadamPaths = await findOfficialQadamPackagePaths()

  // Not a formality. The whole point of 1b is that the catalogue in the image and the catalogue
  // on the registry are the same set; a traversal that silently found nothing (a moved root, a
  // `dist`-only checkout) would publish the three framework packages, report green, and leave
  // the qadams unpublished — which is the exact state #477 must not be flipped on top of.
  if (qadamPaths.length === 0) {
    throw new Error('[publishFrameworkPackages] --include-qadams found no official qadams to pack — refusing to report a successful catalogue publish that shipped none.')
  }
  console.info(`[publishFrameworkPackages] considering ${qadamPaths.length} official qadams`)

  const packedPerChunk: (string | null)[][] = []
  for (const paths of chunk(qadamPaths, QADAM_PACK_CONCURRENCY)) {
    packedPerChunk.push(await Promise.all(paths.map(async (path) => {
      const result = await publishNpmPackage({ path, dryRun, npmDistTag, packDestination, skipRegistryCheck })
      // `skipped` is the normal outcome for a qadam whose version is already on the registry and
      // unchanged since main — with 238 packages it will be nearly all of them on nearly every
      // run, which is what keeps a re-run after a partial publish cheap and safe.
      return result.status === 'packed' ? result.filename : null
    })))
  }

  const packed = packedPerChunk.flat().filter((filename): filename is string => filename !== null)
  console.info(`[publishFrameworkPackages] packed ${packed.length} of ${qadamPaths.length} official qadams (the rest were already published at their current version)`)
  return packed
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes('--dry-run')
  // Keyed on the flag being PRESENT, not on it yielding a value. `--pack-to` with no `=`, or
  // `--pack-to=` with nothing after it, would otherwise leave packDestination falsy and fall
  // straight through to a real `npm publish` — on the one command in this repo that has no
  // undo, and the two likeliest ways to mistype it. CI never hits this (the pack job always
  // interpolates a non-empty runner.temp path) and it holds no credential, but that
  // makes "pack never publishes" a property of the secret being absent rather than an
  // assertion, which is not where it belongs. `slice`, not `split('=')[1]`, so a destination
  // containing an `=` is not silently truncated.
  const packToArg = process.argv.find((arg) => arg === '--pack-to' || arg.startsWith('--pack-to='))
  const packDestination = packToArg?.startsWith('--pack-to=') === true ? packToArg.slice('--pack-to='.length) : undefined
  if (packToArg !== undefined && (packDestination === undefined || packDestination.length === 0)) {
    throw new Error('[publishFrameworkPackages] --pack-to requires a destination: --pack-to=<dir>. Refusing to fall through to a real publish.')
  }
  // Neither publish workflow sets this. release.yml skips the call entirely for a prerelease
  // ref (see its header comment) and publish-packages.yml has no prerelease concept at all, so
  // every CI run here publishes to `latest`.
  // Left overridable for manual/local use — `publishNpmPackage` normalizes an unset or empty
  // value to `latest` on its own.
  const npmDistTag = process.env['NPM_DIST_TAG']
  // See PublishNpmPackageParams.skipRegistryCheck. publishNpmPackage refuses this unless the run
  // also packs, so it cannot be used to force a publish past the already-published guard.
  const skipRegistryCheck = process.argv.includes('--skip-registry-check')
  // Step 1b of #433 (#476). Opt-in rather than always-on so ci.yml's `pack-smoke` job — which
  // exists to prove the real pack path still works on every PR — does not grow a build and pack
  // of the whole catalogue, and so the three framework packages stay publishable on their own.
  const includeQadams = process.argv.includes('--include-qadams')

  // Same shape as the skipRegistryCheck guard above and for the same reason: without a pack
  // destination this function publishes directly from the process that built the tree, which is
  // exactly the shape #486 split apart. Three packages doing that was the old world; 238 doing it
  // would put the whole catalogue through a code path with no artifact to diff and no
  // credential-free packing half.
  if (includeQadams && !packDestination && !dryRun) {
    throw new Error('[publishFrameworkPackages] --include-qadams is only valid with --pack-to or --dry-run — the qadams publish through tools/ci/publish-packed-tarballs.sh, never from the packing process (#486).')
  }

  const packedFilenames: string[] = []
  for (const path of FRAMEWORK_PACKAGE_PATHS) {
    const result = await publishNpmPackage({ path, dryRun, npmDistTag, packDestination, skipRegistryCheck })
    if (result.status === 'packed' && packDestination) {
      packedFilenames.push(result.filename)
    }
  }

  // After the three, never interleaved with them: publish-packed-tarballs.sh walks this manifest
  // in order, so the framework packages a qadam depends on are on the registry before the qadam
  // that names them is, and a client racing the tail never resolves a dependent ahead of its
  // dependency.
  if (includeQadams) {
    packedFilenames.push(...await packOfficialQadams({ dryRun, npmDistTag, packDestination, skipRegistryCheck }))
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

type PackOfficialQadamsParams = {
  dryRun: boolean
  npmDistTag: string | undefined
  packDestination: string | undefined
  skipRegistryCheck: boolean
}
