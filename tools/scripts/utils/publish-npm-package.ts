import assert from 'node:assert'
import { argv } from 'node:process'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readPackageJson } from './files'
import { packagePrePublishChecks } from './package-pre-publish-checks'
import { prepareQadamDistForPublish } from '../../../packages/cli/src/lib/utils/prepare-qadam-utils'
import { isExactVersion } from '../../../packages/cli/src/lib/utils/workspace-utils'

function assertNoSemverRanges(packageJsonPath: string): void {
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

function assertNoUnresolvedWorkspaceDeps(packageJsonPath: string): void {
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

export const publishNpmPackage = async ({ path, dryRun = false }: PublishNpmPackageParams): Promise<void> => {
  console.info(`[publishPackage] path=${path}, dryRun=${dryRun}`)
  assert(path, '[publishPackage] parameter "path" is required')

  const outputPath = `${path}/dist`

  if (!existsSync(`${outputPath}/package.json`)) {
    console.info(`[publishPackage] skipping, no build output at ${outputPath}`)
    return
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
    execSync(`npm pack`, { cwd: outputPath, stdio: 'inherit' })
    console.info(`[publishPackage] dry run, packed only, path=${path}, version=${version}`)
    return
  }

  execSync(`npm publish --access public --tag latest`, { cwd: outputPath, stdio: 'inherit' })

  console.info(`[publishProject] success, path=${path}, version=${version}`)
}

const main = async (): Promise<void> => {
  const path = argv[2]
  const dryRun = argv.includes('--dry-run')
  await publishNpmPackage({ path, dryRun })
}

/*
 * module is entrypoint, not imported i.e. invoked directly
 * see https://nodejs.org/api/modules.html#modules_accessing_the_main_module
 */
if (require.main === module) {
  main()
}

type PublishNpmPackageParams = {
  path: string
  dryRun?: boolean
}
