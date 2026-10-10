//
// The measurement behind ADR-0004's gate 9 (#852): does the tree build of a `0.x` official qadam
// match the npm tarball published under the same version?
//
// ADR-0004: "Every qadam in an image is either its released artifact or carries a `-main.<n>`
// version. ... For `0.x` qadams it means their own code and metadata match the npm tarball." The
// qadams still on `0.x` (the legacy npm format, ADR-0003) are built from the tree, and nothing
// until now compared that build with what is on the registry under the same number: 46 differed at
// `v1.1.0` (ADR-0001; `schedule@0.1.17`'s `ru.json` is the example), so the number named different
// code in the image and on npm.
//
// This file holds the comparison. Two CLIs call it:
//   tools/ci/measure-qadam-divergence.mjs   step 1 of #852: lists every divergent `0.x` qadam
//   tools/ci/check-qadam-divergence.mjs     gate 9 (advisory): the same list minus the qadams a
//                                           pending changeset already turns into a `-main.<n>` build
// Both are tested offline by tools/ci/test-qadam-divergence.sh against a stub registry.
//
// ---------------------------------------------------------------------------
// WHAT "DIFFERS" MEANS
// ---------------------------------------------------------------------------
// The tree side is what the image runs: `<qadam>/dist/src/**` as `turbo run build` leaves it (the
// caller builds first — a missing `dist/src` is UNKNOWN, never "identical"), plus the source
// `src/i18n/*` that `prepareQadamDistForPublish` copies in beside it. The npm side is the tarball
// the registry serves for `name@version`, verified against the integrity the registry itself
// reports. Compared byte for byte, file by file, under `src/`:
//   - every file except `*.map` and `*.d.ts` (see "NOT COMPARED"); `.js` and the i18n `.json`
//     catalogues are the code and data the engine loads;
//   - a file on one side only is a difference, as is a changed one.
// The manifest is compared on what a consumer installs: `dependencies`, `peerDependencies` and
// `optionalDependencies`, after the rewrite the publish applies (workspace specs resolved, `^`/`~`
// stripped). Entries for the platform chain are left out of both sides — `@aiqadam/qadams-framework`,
// `@aiqadam/qadams-common` and `@aiqadam/shared` — because the tree says `workspace:*` and the
// tarball says the version that was current when it was packed; ADR-0003 makes the framework chain
// the platform's, and ADR-0001 (gate 1) exempts the removal of `@aiqadam/shared` from every qadam.
//
// Measured, not assumed: tsc's output for an unchanged source is byte-identical across runs and
// machines, so a clean qadam compares equal (`schedule@0.1.17`'s `.js` files all match except the
// one #813 changed).
//
// ---------------------------------------------------------------------------
// NOT COMPARED, and why
// ---------------------------------------------------------------------------
// - `*.d.ts` and `*.js.map`: types and source maps. They are not loaded at run time, and a `.d.ts`
//   inlines types of `@aiqadam/qadams-framework`, so a framework change would flag every qadam
//   that did not change — ADR-0004 gives such a qadam no snapshot of its own. `--declarations`
//   adds the `.d.ts` files when someone wants to see them.
// - `LICENSE`, `NOTICE`, `README.md`, `main`/`types`/`license`/`repository` in the manifest: added
//   or rewritten by the publish, not by the qadam's own change.
// - `devDependencies`: not installed by a consumer.
// - A qadam whose version is not on npm (`unpublished`) has nothing to compare with. It is
//   reported on its own and not counted as a divergence: it is either a version a release PR just
//   raised, which the publish has not reached yet, or a package nobody published.
// - A qadam whose tree version is already a prerelease is skipped; a `-main.<n>` number is never
//   committed (ADR-0004), so this is a hand-written prerelease, not a snapshot.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------
// A qadam that cannot be measured (registry unreachable, a tarball that fails its integrity check,
// a tree that was not built) has status `unknown`; neither CLI turns that into "identical".
//
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { changesetGate } from './check-changesets.mjs'

export const QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
export const NPM_REGISTRY = 'https://registry.npmjs.org'

// Dependencies the platform provides (ADR-0003), or that no qadam may declare any more.
const PLATFORM_CHAIN = new Set(['@aiqadam/qadams-framework', '@aiqadam/qadams-common', '@aiqadam/shared'])
const DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const REQUEST_TIMEOUT_MS = 30_000

// Every official qadam under packages/qadams/{core,community}, read from its package.json.
export const listQadams = ({ root }) => {
  return QADAM_ROOTS.flatMap((qadamRoot) => listDirs({ dir: path.join(root, qadamRoot) }))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      return { name: manifest.name, version: manifest.version, private: manifest.private === true, dir, manifest }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The qadams still on `0.x`. A qadam with no valid semver version is returned too, with `version`
// as written, so the caller can report it rather than lose it.
export const isZeroX = ({ version }) => typeof version !== 'string' || !semver.valid(version) || semver.major(version) === 0

// name -> highest pending level, from `.changeset/*.md`. `none` does not release anything, so it
// is not a pending release.
export const readPendingReleases = ({ root }) => {
  const dir = path.join(root, '.changeset')
  const pending = new Map()
  if (!fs.existsSync(dir)) {
    return pending
  }
  const rank = { patch: 1, minor: 2, major: 3 }
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.md') && entry !== 'README.md').sort()) {
    const { releases } = changesetGate.parseChangeset({ text: fs.readFileSync(path.join(dir, file), 'utf8') })
    for (const { name, level } of releases) {
      if (level !== 'none' && (rank[level] ?? 0) > (rank[pending.get(name)] ?? 0)) {
        pending.set(name, level)
      }
    }
  }
  return pending
}

// Measures every given qadam. Returns one result per qadam, in the order given:
//   { name, version, dir, status, differences, reason }
// status: 'identical' | 'divergent' | 'unpublished' | 'skipped' | 'unknown'
export const measureQadams = async ({ qadams, registry = NPM_REGISTRY, concurrency = 8, declarations = false, maxAttempts = 4, retryBaseMs = 1000 }) => {
  const results = new Array(qadams.length)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qadam-divergence-'))
  try {
    let next = 0
    const worker = async () => {
      while (next < qadams.length) {
        const index = next++
        results[index] = await measureOne({ qadam: qadams[index], registry, scratch, declarations, maxAttempts, retryBaseMs })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, qadams.length)) }, () => worker()))
  }
  finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  return results
}

const measureOne = async ({ qadam, registry, scratch, declarations, maxAttempts, retryBaseMs }) => {
  const base = { name: qadam.name, version: qadam.version, dir: qadam.dir, differences: [] }
  try {
    if (typeof qadam.name !== 'string' || typeof qadam.version !== 'string' || !semver.valid(qadam.version)) {
      return { ...base, status: 'unknown', reason: 'package.json has no valid name and semver version' }
    }
    if (semver.prerelease(qadam.version) !== null) {
      return { ...base, status: 'skipped', reason: 'the version is already a prerelease' }
    }
    if (qadam.private) {
      return { ...base, status: 'skipped', reason: 'private package, never published' }
    }
    const treeFiles = readTreeFiles({ dir: qadam.dir, declarations })
    const published = await fetchPublished({ registry, name: qadam.name, version: qadam.version, maxAttempts, retryBaseMs })
    if (published === null) {
      return { ...base, status: 'unpublished', reason: `${qadam.name}@${qadam.version} is not on ${registry}` }
    }
    const tarball = await downloadTarball({ registry, published, maxAttempts, retryBaseMs })
    const packageDir = extractTarball({ tarball, scratch, label: `${qadam.name}@${qadam.version}` })
    const npmFiles = readTarballFiles({ packageDir, declarations })
    const npmManifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const differences = [
      ...compareFiles({ tree: treeFiles, npm: npmFiles }),
      ...compareManifests({ tree: qadam.manifest, npm: npmManifest }),
    ]
    return { ...base, status: differences.length === 0 ? 'identical' : 'divergent', differences }
  }
  catch (error) {
    return { ...base, status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---- the tree side --------------------------------------------------------------------------

// relative path (as in the tarball) -> sha256 of the bytes
const readTreeFiles = ({ dir, declarations }) => {
  const built = path.join(dir, 'dist', 'src')
  if (!fs.existsSync(built) || listFiles({ dir: built }).length === 0) {
    throw new Error(`no build output at ${path.join(dir, 'dist', 'src')} — build first (npx turbo run build --filter='@aiqadam/qadam-*')`)
  }
  const files = new Map()
  for (const file of listFiles({ dir: built })) {
    addFile({ files, rel: path.posix.join('src', toPosix(path.relative(built, file))), file, declarations })
  }
  // `prepareQadamDistForPublish` copies src/i18n/* into dist/src/i18n; compare the source it copies.
  const i18n = path.join(dir, 'src', 'i18n')
  for (const file of listFiles({ dir: i18n })) {
    addFile({ files, rel: path.posix.join('src', 'i18n', toPosix(path.relative(i18n, file))), file, declarations })
  }
  return files
}

// ---- the npm side ---------------------------------------------------------------------------

const readTarballFiles = ({ packageDir, declarations }) => {
  const files = new Map()
  for (const file of listFiles({ dir: path.join(packageDir, 'src') })) {
    addFile({ files, rel: path.posix.join('src', toPosix(path.relative(path.join(packageDir, 'src'), file))), file, declarations })
  }
  return files
}

const addFile = ({ files, rel, file, declarations }) => {
  if (rel.endsWith('.map') || (!declarations && rel.endsWith('.d.ts'))) {
    return
  }
  files.set(rel, createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
}

// `null` when the registry has no such package or version; throws when it cannot tell.
const fetchPublished = async ({ registry, name, version, maxAttempts, retryBaseMs }) => {
  const url = `${registry.replace(/\/+$/, '')}/${name.replace('/', '%2f')}`
  const response = await request({ url, accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8', maxAttempts, retryBaseMs, allowNotFound: true })
  if (response === null) {
    return null
  }
  const body = JSON.parse(response.toString('utf8'))
  const versions = body !== null && typeof body === 'object' ? body.versions : undefined
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new Error(`the registry answered for ${name} without a "versions" object — refusing to guess whether ${version} is published`)
  }
  const entry = versions[version]
  if (entry === undefined) {
    return null
  }
  const tarball = entry?.dist?.tarball
  if (typeof tarball !== 'string') {
    throw new Error(`the registry lists ${name}@${version} without a dist.tarball`)
  }
  return { tarball, integrity: entry.dist.integrity, shasum: entry.dist.shasum }
}

const downloadTarball = async ({ registry, published, maxAttempts, retryBaseMs }) => {
  // The tarball must come from the registry the packument came from. A packument that points
  // somewhere else is not something to follow from a CI job.
  if (new URL(published.tarball).origin !== new URL(registry).origin) {
    throw new Error(`the tarball URL ${published.tarball} is not on the registry ${registry}`)
  }
  const bytes = await request({ url: published.tarball, accept: 'application/octet-stream', maxAttempts, retryBaseMs, allowNotFound: false })
  assertIntegrity({ bytes, published })
  return bytes
}

const assertIntegrity = ({ bytes, published }) => {
  if (typeof published.integrity === 'string') {
    const [algorithm, expected] = published.integrity.split(/\s+/)[0].split('-')
    if (!['sha512', 'sha384', 'sha256'].includes(algorithm)) {
      throw new Error(`unsupported integrity algorithm in ${published.integrity}`)
    }
    if (createHash(algorithm).update(bytes).digest('base64') !== expected) {
      throw new Error(`the downloaded tarball does not match the registry's integrity ${published.integrity}`)
    }
    return
  }
  if (typeof published.shasum === 'string') {
    if (createHash('sha1').update(bytes).digest('hex') !== published.shasum) {
      throw new Error(`the downloaded tarball does not match the registry's shasum ${published.shasum}`)
    }
    return
  }
  throw new Error('the registry reports neither an integrity nor a shasum for the tarball, so it cannot be verified')
}

const extractTarball = ({ tarball, scratch, label }) => {
  const dir = fs.mkdtempSync(path.join(scratch, 'pkg-'))
  const file = path.join(dir, 'package.tgz')
  fs.writeFileSync(file, tarball)
  const out = path.join(dir, 'out')
  fs.mkdirSync(out)
  execFileSync('tar', ['xzf', file, '-C', out, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const packageDir = path.join(out, 'package')
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    throw new Error(`the tarball of ${label} has no package/package.json`)
  }
  return packageDir
}

// A GET with retries for what is worth retrying: network errors, timeouts, 429 and 5xx. A 404 is an
// answer when `allowNotFound`; any other status is an error, not a retry.
const request = async ({ url, accept, maxAttempts, retryBaseMs, allowNotFound }) => {
  for (let attempt = 1; ; attempt++) {
    let failure
    try {
      const response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.status === 404 && allowNotFound) {
        return null
      }
      if (response.ok) {
        return Buffer.from(await response.arrayBuffer())
      }
      failure = { retryable: response.status === 429 || response.status >= 500, message: `answered ${response.status}` }
    }
    catch (error) {
      failure = { retryable: true, message: describe({ error }) }
    }
    if (!failure.retryable || attempt >= maxAttempts) {
      throw new Error(`could not read ${url} (attempt ${attempt}/${maxAttempts}): ${failure.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.pow(4, attempt - 1) * retryBaseMs))
  }
}

const describe = ({ error }) => {
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  return `${error instanceof Error ? error.message : String(error)}${cause}`
}

// ---- comparing ------------------------------------------------------------------------------

const compareFiles = ({ tree, npm }) => {
  const paths = [...new Set([...tree.keys(), ...npm.keys()])].sort()
  return paths.flatMap((rel) => {
    if (!npm.has(rel)) {
      return [`only in the tree: ${rel}`]
    }
    if (!tree.has(rel)) {
      return [`only on npm: ${rel}`]
    }
    return tree.get(rel) === npm.get(rel) ? [] : [`changed: ${rel}`]
  })
}

// What a consumer installs, after the rewrite the publish applies to the tree's manifest: a
// `workspace:` spec becomes the exact version of the workspace package at pack time, which the tree
// does not know, so such a dependency is left out of both sides; `^` and `~` are stripped.
export const installedDependencies = ({ manifest, section, exclude = new Set() }) => {
  const entries = Object.entries(manifest?.[section] ?? {}).filter(([name, spec]) => !PLATFORM_CHAIN.has(name) && !exclude.has(name) && typeof spec === 'string')
  return Object.fromEntries(entries.map(([name, spec]) => [name, spec.replace(/^[\^~]/, '')]))
}

const workspaceDependencies = ({ manifest, section }) => {
  return new Set(Object.entries(manifest?.[section] ?? {}).filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:')).map(([name]) => name))
}

const compareManifests = ({ tree, npm }) => {
  return DEPENDENCY_SECTIONS.flatMap((section) => {
    const exclude = workspaceDependencies({ manifest: tree, section })
    const mine = installedDependencies({ manifest: tree, section, exclude })
    const theirs = installedDependencies({ manifest: npm, section, exclude })
    return [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort().flatMap((name) => {
      return mine[name] === theirs[name] ? [] : [`${section}.${name}: tree ${mine[name] ?? 'none'}, npm ${theirs[name] ?? 'none'}`]
    })
  })
}

// ---- small helpers --------------------------------------------------------------------------

const toPosix = (value) => value.split(path.sep).join('/')

const listDirs = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name))
}

const listFiles = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : listFiles({ dir: full })
    }
    return entry.isFile() ? [full] : []
  })
}

// The options both CLIs share, from argv. Returns { options } or { error }. A bare flag, or one
// followed by another flag, is rejected rather than guessed.
export const readCommonOptions = ({ argv }) => {
  const read = ({ flag, fallback }) => {
    const index = argv.indexOf(flag)
    if (index === -1) {
      return { value: fallback }
    }
    const value = argv[index + 1]
    return value === undefined || value.startsWith('--') ? { error: `${flag} needs a value` } : { value }
  }
  const root = read({ flag: '--root', fallback: process.cwd() })
  const registry = read({ flag: '--registry', fallback: NPM_REGISTRY })
  const concurrency = read({ flag: '--concurrency', fallback: '8' })
  const maxAttempts = read({ flag: '--max-attempts', fallback: '4' })
  const retryBaseMs = read({ flag: '--retry-base-ms', fallback: '1000' })
  const failed = [root, registry, concurrency, maxAttempts, retryBaseMs].find((option) => option.error !== undefined)
  if (failed) {
    return { error: failed.error }
  }
  const numbers = { concurrency: Number(concurrency.value), maxAttempts: Number(maxAttempts.value), retryBaseMs: Number(retryBaseMs.value) }
  if (!Number.isInteger(numbers.concurrency) || numbers.concurrency < 1 || !Number.isInteger(numbers.maxAttempts) || numbers.maxAttempts < 1 || !Number.isInteger(numbers.retryBaseMs) || numbers.retryBaseMs < 0) {
    return { error: '--concurrency and --max-attempts must be positive integers and --retry-base-ms a non-negative one' }
  }
  return {
    options: { root: path.resolve(root.value), registry: registry.value, declarations: argv.includes('--declarations'), ...numbers },
  }
}
