import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as semver from 'semver'
import { readPackageJson } from './files'
import { OFFICIAL_QADAM_ROOTS } from './qadam-publish-paths'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const CONFIG_PATH = join(REPO_ROOT, 'tools', 'scripts', 'qadams', 'bundle', 'qadam-artifact-config.json')

// ADR-0003 "Qadams at `1.0.0`": a qadam's 1.0.0 is the release that switches it to the bundle
// artifact format (`@aiqadam/*` and `zod` as `peerDependencies`); every `0.x` version stays the
// legacy npm format publish-npm-package.ts already publishes. This is the one place that decides
// which format a given official-qadam path+version publishes as — publishNpmPackage branches on
// it before the legacy `dist`-output check, which a bundle artifact (built straight from `src`,
// never from a qadam's own `dist`) does not satisfy.
export const isBundleFormatQadam = async ({ path }: IsBundleFormatQadamParams): Promise<boolean> => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const isOfficialQadam = OFFICIAL_QADAM_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  if (!isOfficialQadam) {
    // packages/qadams/framework and packages/qadams/common sit beside the two official roots —
    // they are the platform `@aiqadam/*` peers a bundle declares, never a bundle themselves.
    return false
  }
  const { version } = await readPackageJson(path)
  const parsed = semver.valid(version)
  if (parsed === null) {
    throw new Error(`[isBundleFormatQadam] ${path}/package.json has an invalid version: "${version}"`)
  }
  return semver.major(parsed) >= 1
}

// Builds and packs one qadam version as the ADR-0003 bundle artifact — the bundle-format
// counterpart of publishNpmPackage's legacy branch. Always a pack, never a direct `npm publish`:
// every official qadam already goes through packOfficialQadams in
// tools/scripts/publish-framework-packages.ts, which only ever calls this with a pack
// destination (#486's pack → publish-packed-tarballs.sh split) — publishNpmPackage itself refuses
// to call this without one.
export const packQadamBundleArtifact = async ({ path, version, packDestination }: PackQadamBundleArtifactParams): Promise<{ filename: string, version: string }> => {
  const { qadamArtifact, ARTIFACT_STATUS } = await importQadamArtifact()
  const [outRoot, config, builtAgainst] = await Promise.all([getHost(), getConfig(), getBuiltAgainst()])
  mkdirSync(packDestination, { recursive: true })
  const result = await qadamArtifact.build({
    qadamDir: join(REPO_ROOT, path),
    outRoot,
    repoRoot: REPO_ROOT,
    config,
    loadCheck: true,
    pack: true,
    packDestination,
    builtAgainst,
  })
  if (result.status !== ARTIFACT_STATUS.OK || !result.tarball) {
    throw new Error(`[packQadamBundleArtifact] bundle build failed for ${path}@${version}: ${result.status}${result.error ? ` — ${result.error}` : ''}`)
  }
  if (result.version !== version) {
    throw new Error(`[packQadamBundleArtifact] built ${path} as ${result.version}, expected ${version}`)
  }
  return { filename: result.tarball.file, version: result.version }
}

// `import()`, not a static import: the builder (tools/scripts/qadams/bundle/) is ESM and this
// file's own project (tools/tsconfig.tools.json) compiles to CommonJS under ts-node, which cannot
// `require()` an ESM module. TypeScript leaves a dynamic `import()` call untouched under
// `module: commonjs` rather than downleveling it to `require`, so it still resolves through
// Node's real ESM loader at run time.
const importQadamArtifact = () => import('../qadams/bundle/qadam-artifact.mjs')

const readBuiltAgainstOnce = async () => {
  const { qadamArtifact } = await importQadamArtifact()
  return qadamArtifact.readBuiltAgainst({ repoRoot: REPO_ROOT })
}

// Lazily built once per process and shared by every qadam this run packs: every bundle resolves
// `@aiqadam/*` and zod upward from the same host directory, which is exactly what the store does
// in production (ADR-0003) — see qadam-artifact.mjs's own header for why `outRoot` must sit
// outside the repository.
let hostPromise: Promise<string> | null = null
const getHost = async (): Promise<string> => {
  if (hostPromise === null) {
    hostPromise = (async () => {
      const { qadamArtifact } = await importQadamArtifact()
      const outRoot = mkdtempSync(join(tmpdir(), 'qadam-flow-bundle-publish-'))
      await qadamArtifact.provisionHost({ outRoot, repoRoot: REPO_ROOT })
      return outRoot
    })()
  }
  return hostPromise
}

let builtAgainstPromise: ReturnType<typeof readBuiltAgainstOnce> | null = null
const getBuiltAgainst = async (): ReturnType<typeof readBuiltAgainstOnce> => {
  if (builtAgainstPromise === null) {
    builtAgainstPromise = readBuiltAgainstOnce()
  }
  return builtAgainstPromise
}

// The same exceptions file for every qadam this run packs — memoized for the same reason
// getHost/getBuiltAgainst are: re-reading and re-parsing it per qadam would mean up to 238 reads
// of one invariant file across a full catalogue pack.
let configPromise: Promise<unknown> | null = null
const getConfig = async (): Promise<unknown> => {
  if (configPromise === null) {
    configPromise = (async () => {
      try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      }
      catch (e) {
        throw new Error(`[packQadamBundleArtifact] cannot read ${CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
  }
  return configPromise
}

type IsBundleFormatQadamParams = {
  path: string
}

type PackQadamBundleArtifactParams = {
  path: string
  version: string
  packDestination: string
}
