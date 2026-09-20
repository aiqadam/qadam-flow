import { argv, env } from 'node:process'
import { publishNpmPackage } from './utils/publish-npm-package'

// Every qadam depends on these three through the bun workspace protocol
// (`"@aiqadam/shared": "workspace:*"`, etc. — see #475), so they are step 1a of the
// version-model decision in #433 and must publish before any qadam (#476, step 1b) can.
// `framework` and `common` themselves depend on `shared` (`common` on both), so the order
// below is the dependency order — not load-bearing for `npm publish` itself (it uploads
// whatever version each package.json declares without resolving it), but it means a
// registry client racing the tail of this job never observes a dependent published ahead
// of what it depends on.
const FRAMEWORK_PACKAGE_PATHS = [
  'packages/shared',
  'packages/qadams/framework',
  'packages/qadams/common',
]

const main = async (): Promise<void> => {
  const dryRun = argv.includes('--dry-run')
  // Set by release.yml from `github.ref_name` — `next` for a prerelease tag (`v2.1.0-rc.1`),
  // `latest` otherwise — never inferred from these packages' own version numbers, which
  // version independently of the release tag and carry no prerelease marker today.
  const npmDistTag = env['NPM_DIST_TAG']

  for (const path of FRAMEWORK_PACKAGE_PATHS) {
    await publishNpmPackage({ path, dryRun, npmDistTag })
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
