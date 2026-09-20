import assert from 'node:assert'
import { argv } from 'node:process'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackageJson } from './files'
import { packagePrePublishChecks } from './package-pre-publish-checks'
import { prepareQadamDistForPublish } from '../../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { isExactVersion } from '../../../packages/cli/src/lib/utils/workspace-utils'

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

export const publishNpmPackage = async ({ path, dryRun = false, npmDistTag = 'latest' }: PublishNpmPackageParams): Promise<void> => {
  console.info(`[publishPackage] path=${path}, dryRun=${dryRun}, npmDistTag=${npmDistTag}`)
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

  if (dryRun) {
    // A destination OUTSIDE outputPath: `npm pack` with no `--pack-destination` writes the
    // tarball into its own cwd, and npm's default ignore rules do not exclude `.tgz` — a
    // second run (or the real publish that follows in the same job) would then pack the
    // previous run's own tarball into the new one. Verified by reproducing it: a bare
    // `npm pack` run twice from `outputPath` embeds the first tarball inside the second.
    const packDestination = mkdtempSync(join(tmpdir(), 'qadam-flow-npm-pack-'))
    execSync(`npm pack --pack-destination ${packDestination}`, { cwd: outputPath, stdio: 'inherit' })
    console.info(`[publishPackage] dry run, packed only, path=${path}, version=${version}, destination=${packDestination}`)
    return
  }

  // --provenance needs `permissions: { id-token: write }` on the calling job (for the OIDC
  // token npm exchanges for the signed attestation) and a `repository` field on the
  // package.json being published, which npm records in that attestation. Without either,
  // a hand-published tarball from an exfiltrated token is indistinguishable from a real
  // release build — `npm audit signatures` has nothing to check.
  execSync(`npm publish --access public --tag ${npmDistTag} --provenance`, { cwd: outputPath, stdio: 'inherit' })

  console.info(`[publishProject] success, path=${path}, version=${version}, npmDistTag=${npmDistTag}`)
}

const main = async (): Promise<void> => {
  const path = argv[2]
  const dryRun = argv.includes('--dry-run')
  const npmDistTagArg = argv.find((arg) => arg.startsWith('--npm-tag='))
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
