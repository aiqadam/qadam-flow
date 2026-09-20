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
const REPO_LICENSE_PATH = join(__dirname, '..', '..', '..', 'LICENSE')

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

export const publishNpmPackage = async ({ path, dryRun = false, npmDistTag }: PublishNpmPackageParams): Promise<void> => {
  // A set-but-empty npmDistTag (e.g. an env var exported as "") is not `undefined`, so a
  // destructured default alone would not catch it — normalized once, here, rather than trusted
  // to every caller.
  const resolvedNpmDistTag = npmDistTag || 'latest'
  if (!NPM_DIST_TAG_PATTERN.test(resolvedNpmDistTag)) {
    throw new Error(`[publishPackage] refusing to publish with invalid npm dist-tag "${resolvedNpmDistTag}"`)
  }

  console.info(`[publishPackage] path=${path}, dryRun=${dryRun}, npmDistTag=${resolvedNpmDistTag}`)
  assert(path, '[publishPackage] parameter "path" is required')

  const outputPath = `${path}/dist`

  // A missing build output used to be a silent skip (console.info + return 0). Now that a CI job
  // depends on this succeeding for a specific, known set of packages, a build-output path that
  // moved (a turbo config change, a renamed `dist`) must fail loudly rather than report the job
  // green while publishing nothing.
  if (!existsSync(`${outputPath}/package.json`)) {
    throw new Error(`[publishPackage] no build output at ${outputPath} for ${path} — refusing to silently skip`)
  }

  const packageAlreadyPublished = await packagePrePublishChecks(path);
  if (packageAlreadyPublished) {
    return;
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

  if (dryRun) {
    // A destination OUTSIDE outputPath: `npm pack` with no `--pack-destination` writes the
    // tarball into its own cwd, and npm's default ignore rules do not exclude `.tgz` — a
    // second run (or the real publish that follows in the same job) would then pack the
    // previous run's own tarball into the new one. Verified by reproducing it: a bare
    // `npm pack` run twice from `outputPath` embeds the first tarball inside the second.
    // execFileSync, not a template-string execSync: packDestination is process-generated and
    // safe either way, but npmDistTag below is not (env-var sourced), and running both through
    // the same code shape rather than one safe and one shell-interpolated is the point.
    const packDestination = mkdtempSync(join(tmpdir(), 'qadam-flow-npm-pack-'))
    execFileSync('npm', ['pack', '--pack-destination', packDestination], { cwd: outputPath, stdio: 'inherit' })
    console.info(`[publishPackage] dry run, packed only, path=${path}, version=${version}, destination=${packDestination}`)
    return
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
}
