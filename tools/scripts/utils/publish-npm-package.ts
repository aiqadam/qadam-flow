import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackageJson } from './files'
import { packagePrePublishChecks } from './package-pre-publish-checks'
import { prepareQadamDistForPublish } from '../../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { isExactVersion } from '../../../packages/cli/src/lib/utils/workspace-utils'

const NPM_DIST_TAG_PATTERN = /^[a-z][a-z0-9-]*$/
// Dropped into the pack destination whenever the registry check was bypassed. Its only job is to
// exist: tools/ci/publish-packed-tarballs.sh refuses ANY directory entry its manifest does not
// declare, so the name does not have to be known there and this file needs no counterpart.
// tools/ci/test-publish-packed-tarballs.sh pins that a marker-bearing directory is refused, so
// narrowing that sweep would fail a test rather than quietly make skip-check packs publishable.
//
// NOT a dotfile, deliberately: `actions/upload-artifact@v4` defaults `include-hidden-files` to
// false, so a `.`-prefixed marker would be dropped at upload and never reach the job that
// downloads the tarballs — which is the one boundary this has to survive to be worth anything.
// Not exported: nothing in TypeScript consumes it, and the shell side pins the spelling instead.
const SKIP_REGISTRY_CHECK_MARKER = 'PACKED-WITH-SKIP-REGISTRY-CHECK'
const REPO_LICENSE_PATH = join(__dirname, '..', '..', '..', 'LICENSE')
// Spelled exactly as the three framework packages already spell it in their own manifests, so a
// package that declares `repository` and one that has it filled in below are indistinguishable
// on the registry.
const REPOSITORY_URL = 'https://github.com/aiqadam/qadam-flow.git'

// `workspace:` deps are deliberately not "exact" here — they are a different, later-resolved
// concern (assertNoUnresolvedWorkspaceDeps's job) and always present on the SOURCE manifest of
// every one of these packages, so this function has to tolerate them to be usable there at all.
// Everything else must be a plain exact version: a caret/tilde range reaching this function on
// the SOURCE manifest is exactly the defect class stripSemverRanges cannot see (it silently
// collapses `^x.y.z` to its floor rather than the version actually resolved and tested), so
// catching it here, before that collapse ever runs, is the whole point of calling this on the
// source manifest in publishNpmPackage below.
export function assertNoSemverRanges(packageJsonPath: string): void {
  const json = JSON.parse(readFileSync(packageJsonPath).toString())
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const
  const ranged: string[] = []

  for (const field of depFields) {
    const deps: Record<string, string> | undefined = json[field]
    if (!deps) {
      continue
    }
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('workspace:')) {
        continue
      }
      if (!isExactVersion(version)) {
        ranged.push(`${field}.${name}: ${version}`)
      }
    }
  }

  if (ranged.length > 0) {
    throw new Error(
      `[publishPackage] refusing to publish ${json.name}@${json.version} — non-exact versions found:\n  ${ranged.join('\n  ')}`,
    )
  }
}

export function assertNoUnresolvedWorkspaceDeps(packageJsonPath: string): void {
  const json = JSON.parse(readFileSync(packageJsonPath).toString())
  const depFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const
  const unresolved: string[] = []

  for (const field of depFields) {
    const deps: Record<string, string> | undefined = json[field]
    if (!deps) {
      continue
    }
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('workspace:')) {
        unresolved.push(`${field}.${name}: ${version}`)
      }
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `[publishPackage] refusing to publish ${json.name}@${json.version} — unresolved workspace dependencies:\n  ${unresolved.join('\n  ')}`,
    )
  }
}

export const publishNpmPackage = async ({ path, dryRun = false, npmDistTag, packDestination, skipRegistryCheck = false }: PublishNpmPackageParams): Promise<PublishNpmPackageResult> => {
  // A set-but-empty npmDistTag (e.g. an env var exported as "") is not `undefined`, so a
  // destructured default alone would not catch it — normalized once, here, rather than trusted
  // to every caller.
  const resolvedNpmDistTag = npmDistTag || 'latest'
  if (!NPM_DIST_TAG_PATTERN.test(resolvedNpmDistTag)) {
    throw new Error(`[publishPackage] refusing to publish with invalid npm dist-tag "${resolvedNpmDistTag}"`)
  }

  console.info(`[publishPackage] path=${path}, dryRun=${dryRun}, npmDistTag=${resolvedNpmDistTag}`)
  assert(path, '[publishPackage] parameter "path" is required')

  // Ahead of every other check, including the build-output one below: this is a structural
  // refusal about how the function was called, and a caller that gets it wrong should be told
  // that rather than told its `dist` is missing.
  //
  // Two independent guards, because this one flag removes the only decision about what gets
  // uploaded. packagePrePublishChecks is what stops a second publish of an already-published
  // version and what throws when a changed package was not bumped; since #486 split the
  // pipeline, nothing downstream re-checks either — tools/ci/publish-packed-tarballs.sh
  // publishes every manifest line it is handed.
  //
  // The first guard, here, stops this call from publishing. Note what it does NOT stop, and why
  // the second one below exists: `packDestination` no longer means "this run stops short of the
  // registry". Since the split it means "this is the PACK HALF of a publish", so satisfying this
  // guard is exactly what adding the flag to the real pack step would do. That would put
  // all three tarballs in the manifest regardless of publish state, and a re-run after a partial
  // publish — the case packagePrePublishChecks exists for — would 403 on the first already-
  // published package and abort before the ones that still needed publishing.
  if (skipRegistryCheck && !packDestination && !dryRun) {
    throw new Error('[publishPackage] skipRegistryCheck is only valid with packDestination or dryRun — refusing to publish with the already-published and version-bump guards disabled.')
  }

  const outputPath = `${path}/dist`

  // A missing build output used to be a silent skip (console.info + return 0). Now that a CI job
  // depends on this succeeding for a specific, known set of packages, a build-output path that
  // moved (a turbo config change, a renamed `dist`) must fail loudly rather than report the job
  // green while publishing nothing.
  if (!existsSync(`${outputPath}/package.json`)) {
    throw new Error(`[publishPackage] no build output at ${outputPath} for ${path} — refusing to silently skip`)
  }

  if (!skipRegistryCheck) {
    const packageAlreadyPublished = await packagePrePublishChecks(path);
    if (packageAlreadyPublished) {
      // No tarball is produced, so in pack mode this package simply does not appear in the
      // publish manifest and the publishing job never sees it. That is what keeps a re-run
      // after a partial failure safe, exactly as it was when one job did both halves.
      return { status: 'skipped' };
    }
  }
  const { version } = await readPackageJson(path)

  // Runs on the SOURCE manifest, before prepareQadamDistForPublish ever touches it: stripSemverRanges
  // (called from inside prepareQadamDistForPublish) silently collapses a "^x.y.z"/"~x.y.z" dependency
  // to its floor rather than the version actually resolved and tested — by the time the equivalent
  // check below runs on the DIST manifest, that collapse has already happened and the version looks
  // exact, so it can never catch this. Catching it here means a caret/tilde range added to any of
  // these three manifests fails the publish loudly instead of shipping consumers an undertested floor
  // version pinned so exactly nothing downstream can move it back.
  assertNoSemverRanges(`${path}/package.json`)

  // Rewrites every "workspace:*" dependency (direct, not transitive) to the exact version
  // read from that dependency's own source package.json — never from bun.lock, whose
  // recorded version for a workspace package can go stale on an ordinary `bun install`
  // when only the package's own version field changed (observed on this repo: a shared
  // version bump with no dependency changes left bun.lock quoting the prior version after
  // both `bun install` and `bun install --force`). Operates on the staged `dist/package.json`
  // copy only; the source tree keeps `workspace:*`. For qadams built via CLI or
  // prepare-qadams-for-publish, this already ran during build — calling it again is
  // idempotent. For shared/common/framework, this is the only place it runs before publish.
  prepareQadamDistForPublish(path)

  const json = JSON.parse(readFileSync(`${outputPath}/package.json`).toString())
  json.version = version
  json.main = './src/index.js'
  json.types = './src/index.d.ts'
  // Filled in here rather than hand-added to 238 manifests, and only when the source manifest
  // does not already carry them — shared/qadams-framework/qadams-common declare both and keep
  // exactly what they declare. Every qadam under packages/qadams/{core,community} declares
  // neither, which matters for two separate reasons:
  //
  //   * `repository` is this pipeline's own stated precondition for --provenance (see the
  //     comment on the publish call below): npm records it in the attestation, and without it a
  //     tarball hand-published from an exfiltrated token is harder to tell from a release build.
  //   * `license` is what npm and every license scanner read. The LICENSE file copied in below
  //     and the generated README both say MIT; a manifest with no `license` field publishes the
  //     catalogue as license-undeclared while the README in the same tarball claims otherwise.
  //
  // `directory` is the package's own path, which is what makes the attestation point at the
  // subtree that produced the tarball rather than at the monorepo root.
  json.license = json.license ?? 'MIT'
  json.repository = json.repository ?? { type: 'git', url: REPOSITORY_URL, directory: path }
  writeFileSync(`${outputPath}/package.json`, JSON.stringify(json, null, 2))

  assertNoUnresolvedWorkspaceDeps(`${outputPath}/package.json`)
  assertNoSemverRanges(`${outputPath}/package.json`)

  // A tarball with an SPDX license string and no license text, and a blank npm package page, is
  // the same "avoidable, first public artifact" problem the manifest metadata fields fix one
  // step further. `npm pack`/`npm publish` include anything present in the package root that
  // isn't excluded, so dropping these into `dist/` is enough — no `files`/manifest change needed.
  copyFileSync(REPO_LICENSE_PATH, join(outputPath, 'LICENSE'))
  writeFileSync(
    join(outputPath, 'README.md'),
    `# ${json.name}\n\n${json.description ?? ''}\n\nPart of the [Qadam Flow](https://github.com/aiqadam/qadam-flow) monorepo. See the repository for documentation. Licensed under MIT.\n`,
  )

  // Pack and dry run are the same operation with a different destination: stage `dist`, run
  // every check above, produce the tarball, stop short of the registry. They share this branch
  // deliberately — the `pack-framework-packages` job hands its tarball to a separate
  // publishing job (#486), and if that artifact were produced by a code path `--dry-run` does
  // not exercise, a local dry run would stop being evidence about the release.
  //
  // A destination OUTSIDE outputPath: `npm pack` with no `--pack-destination` writes the
  // tarball into its own cwd, and npm's default ignore rules do not exclude `.tgz` — a
  // second run would then pack the previous run's own tarball into the new one. Verified by
  // reproducing it: a bare `npm pack` run twice from `outputPath` embeds the first tarball
  // inside the second.
  // execFileSync, not a template-string execSync: the destination is caller-supplied and
  // npmDistTag below is env-var sourced, and running both through the same code shape rather
  // than one safe and one shell-interpolated is the point.
  if (packDestination || dryRun) {
    const destination = packDestination ?? mkdtempSync(join(tmpdir(), 'qadam-flow-npm-pack-'))
    // `--json` rather than deriving the filename from name+version ourselves: npm owns the
    // scope-mangling rule (`@aiqadam/shared` -> `aiqadam-shared-0.135.0.tgz`), and a publish
    // manifest built from our guess at it would send the publishing job looking for a file
    // that is not there — a failure that could only ever surface on a real tag.
    // stdout piped so it can be parsed; stderr inherited so npm's own diagnostics still reach
    // the log rather than being swallowed into a variable nobody prints.
    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
      cwd: outputPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const filename = parsePackedFilename(packOutput)

    // The second guard: make a skip-check pack structurally unpublishable rather than
    // unpublishable by convention. tools/ci/publish-packed-tarballs.sh refuses any directory
    // entry its manifest does not declare, so this marker aborts it before it publishes anything
    // out of a directory packed with the guards off — including across the artifact upload and
    // download between the packing job (_pack-framework-packages.yml) and each caller's own
    // publishing job, which is why the name is not a dotfile.
    // ci.yml's `pack-smoke` reads only the manifest and is unaffected.
    //
    // What this is: a stop on maintainer error and on this flag drifting from ci.yml's smoke job
    // into the real pack step. What it is not: a control against anyone who can edit that
    // workflow, who could equally delete this write or widen the sweep. The required-reviewers
    // `npm-publish` environment remains the actual provenance control.
    if (skipRegistryCheck) {
      writeFileSync(
        join(destination, SKIP_REGISTRY_CHECK_MARKER),
        'Packed with --skip-registry-check: the already-published and version-bump guards were\ndisabled, so these tarballs are a build smoke test and must never be published.\n',
      )
    }

    console.info(`[publishPackage] packed only, path=${path}, version=${version}, filename=${filename}, destination=${destination}`)
    return { status: 'packed', filename, version }
  }

  // --provenance needs `permissions: { id-token: write }` on the calling job (for the OIDC
  // token npm exchanges for the signed attestation) and a `repository` field on the
  // package.json being published, which npm records in that attestation. Without either,
  // a hand-published tarball from an exfiltrated token is indistinguishable from a real
  // release build — `npm audit signatures` has nothing to check. execFileSync (argv array, no
  // shell) rather than execSync template-string interpolation: a step holding an org publish
  // token should not build a shell command out of an env-var-sourced value, even a validated one.
  execFileSync('npm', ['publish', '--access', 'public', '--tag', resolvedNpmDistTag, '--provenance'], { cwd: outputPath, stdio: 'inherit' })

  console.info(`[publishProject] success, path=${path}, version=${version}, npmDistTag=${resolvedNpmDistTag}`)
  return { status: 'published', version }
}

// npm pack --json emits an array with one entry per packed package. Anything else means npm
// changed a contract this pipeline reads, which must fail the pack job rather than produce a
// manifest naming a file that does not exist.
function parsePackedFilename(packOutput: string): string {
  const parsed: unknown = JSON.parse(packOutput)
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`[publishPackage] expected exactly one packed artifact from \`npm pack --json\`, got: ${packOutput}`)
  }
  const entry: unknown = parsed[0]
  if (typeof entry !== 'object' || entry === null || !('filename' in entry)) {
    throw new Error(`[publishPackage] \`npm pack --json\` reported no filename: ${packOutput}`)
  }
  const filename: unknown = entry.filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error(`[publishPackage] \`npm pack --json\` reported no filename: ${packOutput}`)
  }
  return filename
}

const main = async (): Promise<void> => {
  const path = process.argv[2]
  const dryRun = process.argv.includes('--dry-run')
  const npmDistTagArg = process.argv.find((arg) => arg.startsWith('--npm-tag='))
  const npmDistTag = npmDistTagArg?.split('=')[1]
  await publishNpmPackage({ path, dryRun, npmDistTag })
}

/*
 * module is entrypoint, not imported i.e. invoked directly
 * see https://nodejs.org/api/modules.html#modules_accessing_the_main_module
 */
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}

type PublishNpmPackageParams = {
  path: string
  dryRun?: boolean
  npmDistTag?: string
  // Set by the pack half of the split release pipeline (#486). Produces the tarball in this
  // directory instead of publishing it; `dryRun` is the same behaviour into a temp directory.
  packDestination?: string
  // Skip packagePrePublishChecks entirely. Exists for ci.yml's `pack-smoke` job, whose whole
  // purpose is to prove the real build-stage-pack path still works: with the check in place that
  // job would pack NOTHING once these versions are published and unchanged, and go green having
  // exercised nothing. It also drops the job's dependency on registry.npmjs.org being reachable.
  // Rejected above unless the run also packs rather than publishes.
  skipRegistryCheck?: boolean
}

type PublishNpmPackageResult =
  | { status: 'skipped' }
  | { status: 'packed'; filename: string; version: string }
  | { status: 'published'; version: string }
