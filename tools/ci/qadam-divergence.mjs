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
// a tree that was not built, a tarball holding a symlink, hardlink, FIFO or device, a changeset that does not
// parse) has status `unknown`; neither CLI turns that into "identical".
//
// UNTRUSTED INPUT: a tarball's member names and a registry's error text reach the log, the
// `::warning::` annotations and the step summary. `sanitize` strips control characters and `::` from
// everything taken from there, so a file named `x\n::error::...` cannot inject a workflow command.
// The tarball is listed before it is extracted and refused if it holds anything but regular files and
// directories: a symlink or hardlink would be followed out of the scratch directory, a FIFO would
// block the read for good.
//
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { changesetGate } from './check-changesets.mjs'

export const qadamDivergence = {
  listQadams: (...args) => listQadams(...args),
  isZeroX: (...args) => isZeroX(...args),
  readChangesets: (...args) => readChangesets(...args),
  measureQadams: (...args) => measureQadams(...args),
  classify: (...args) => classify(...args),
  readCommonOptions: (...args) => readCommonOptions(...args),
  sanitize: (...args) => sanitize(...args),
}

const QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
const NPM_REGISTRY = 'https://registry.npmjs.org'
// Dependencies the platform provides (ADR-0003), or that no qadam may declare any more.
const PLATFORM_CHAIN = new Set(['@aiqadam/qadams-framework', '@aiqadam/qadams-common', '@aiqadam/shared'])
const DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const REQUEST_TIMEOUT_MS = 30_000
// A registry that asks to be left alone for longer than this is treated as down for this run: the
// request fails at once (status unknown) instead of waiting, because 30 waves of workers waiting
// that long would outlast the CI job.
const MAX_RETRY_AFTER_MS = 20_000

// Every official qadam under packages/qadams/{core,community}, read from its package.json.
const listQadams = ({ root }) => {
  return QADAM_ROOTS.flatMap((qadamRoot) => listDirs({ dir: path.join(root, qadamRoot) }))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      return { name: manifest.name, version: manifest.version, private: manifest.private === true, dir, manifest }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The qadams still on `0.x`. A qadam with no valid semver version is kept too, with `version` as
// written, so the caller can report it rather than lose it.
const isZeroX = ({ version }) => typeof version !== 'string' || !semver.valid(version) || semver.major(version) === 0

// Every `.changeset/*.md`, parsed by the changesets gate's own parser, and the problems it found. A
// changeset that does not parse cannot be read as "covers nothing" — it may be the one that covers a
// qadam — so the caller fails on `problems` the way compute-main-version.mjs does.
const readChangesets = ({ root }) => {
  const dir = path.join(root, '.changeset')
  if (!fs.existsSync(dir)) {
    return { changesets: [], problems: [] }
  }
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort()
  const changesets = files.map((name) => ({ name, ...changesetGate.parseChangeset({ text: fs.readFileSync(path.join(dir, name), 'utf8') }) }))
  const problems = changesets.filter((changeset) => changeset.problems.length > 0).map((changeset) => sanitize({ text: `.changeset/${changeset.name}: ${changeset.problems.join('; ')}` }))
  return { changesets, problems }
}

// Sorts measured results into the buckets both CLIs report, and splits the divergent ones by
// whether a pending release (patch, minor or major; `none` releases nothing) already covers them.
// `levelOf(name)` is the pending level, or null.
const classify = ({ results, changesets }) => {
  const by = (status) => results.filter((result) => result.status === status)
  const levelOf = (name) => {
    const level = changesetGate.pendingLevel({ changesets, name })
    return level === 'none' ? null : level
  }
  const divergent = by('divergent')
  return {
    identical: by('identical'),
    divergent,
    uncovered: divergent.filter((result) => levelOf(result.name) === null),
    covered: divergent.filter((result) => levelOf(result.name) !== null),
    unpublished: by('unpublished'),
    skipped: by('skipped'),
    unknown: by('unknown'),
    levelOf,
  }
}

// Measures every given qadam. Returns one result per qadam, in the order given:
//   { name, version, dir, status, differences, reason }
// status: 'identical' | 'divergent' | 'unpublished' | 'skipped' | 'unknown'
const measureQadams = async ({ qadams, registry = NPM_REGISTRY, concurrency = 8, declarations = false, maxAttempts = 4, retryBaseMs = 1000 }) => {
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
    removeScratch({ scratch })
  }
  return results
}

// The options both CLIs share, from argv. Returns { options } or { error }. A bare flag, or one
// followed by another flag, is rejected rather than guessed.
const readCommonOptions = ({ argv }) => {
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

// Text that came from a tarball, a registry or a package.json, made safe to print into a log line,
// a workflow command or a markdown table: control characters (newlines included), `::` and the
// legacy `##[` prefix (the runner honours it anywhere in a line, so `##[stop-commands]` would silence
// every later warning) go, so nothing in it can start a command or break out of a line.
const sanitize = ({ text }) => {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?').replace(/::/g, ': :').replace(/##\[/g, '# #[')
}

// Never allowed to throw: by now every result is in hand, and a cleanup failure must not discard them.
const removeScratch = ({ scratch }) => {
  try {
    execFileSync('chmod', ['-R', 'u+rwx', scratch], { stdio: 'ignore' })
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  catch (error) {
    console.error(`[qadam-divergence] could not remove ${scratch}: ${describe({ error })}`)
  }
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
    // The registry first: a version that is not on npm has nothing to compare with, whether or not
    // the tree was built.
    const published = await fetchPublished({ registry, name: qadam.name, version: qadam.version, maxAttempts, retryBaseMs })
    if (published === null) {
      return { ...base, status: 'unpublished', reason: `${qadam.name}@${qadam.version} is not on ${registry}` }
    }
    const treeFiles = readTreeFiles({ dir: qadam.dir, declarations })
    const tarball = await downloadTarball({ registry, published, maxAttempts, retryBaseMs })
    const packageDir = extractTarball({ tarball, scratch, label: `${qadam.name}@${qadam.version}` })
    const npmFiles = readTarballFiles({ packageDir, declarations })
    const npmManifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const differences = [
      ...compareFiles({ tree: treeFiles, npm: npmFiles }),
      ...compareManifests({ tree: qadam.manifest, npm: npmManifest }),
    ].map((difference) => sanitize({ text: difference }))
    return { ...base, status: differences.length === 0 ? 'identical' : 'divergent', differences }
  }
  catch (error) {
    return { ...base, status: 'unknown', reason: sanitize({ text: error instanceof Error ? error.message : String(error) }) }
  }
}

// ---- the tree side --------------------------------------------------------------------------

// relative path (as in the tarball) -> sha256 of the bytes
const readTreeFiles = ({ dir, declarations }) => {
  const built = path.join(dir, 'dist', 'src')
  const builtFiles = listFiles({ dir: built })
  if (builtFiles.length === 0) {
    throw new Error(`no build output at ${built} — build first (npx turbo run build --filter='@aiqadam/qadam-*')`)
  }
  const files = new Map()
  for (const file of builtFiles) {
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
  // Listed first, and only regular files and directories accepted: a symlink member could redirect a
  // later member's write, or a read of the extracted tree, outside the scratch directory; a FIFO
  // named package.json would block the read forever and freeze the job; a device is not a package.
  const listing = execFileSync('tar', ['tvzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const unusual = listing.split('\n').filter((line) => line !== '' && !line.startsWith('-') && !line.startsWith('d'))
  if (unusual.length > 0) {
    throw new Error(`the tarball of ${label} holds ${unusual.length} member(s) that are neither a regular file nor a directory (symlink, hardlink, FIFO, device), which this check does not read: ${sanitize({ text: unusual[0] })}`)
  }
  const out = path.join(dir, 'out')
  fs.mkdirSync(out)
  execFileSync('tar', ['xzf', file, '-C', out, '--no-same-owner', '--no-same-permissions'], { stdio: ['ignore', 'ignore', 'pipe'] })
  // A directory stored with mode 000 would make the walk below, and the removal of the scratch
  // directory, fail. Nothing extracted is a link (checked above), so a recursive chmod stays inside.
  execFileSync('chmod', ['-R', 'u+rwx', out], { stdio: ['ignore', 'ignore', 'pipe'] })
  // And checked again on what was written, by lstat, which does not follow.
  const linked = findLinks({ dir: out })
  if (linked.length > 0) {
    throw new Error(`the extracted tarball of ${label} holds a symlink or hardlink: ${sanitize({ text: path.relative(out, linked[0]) })}`)
  }
  const packageDir = path.join(out, 'package')
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    throw new Error(`the tarball of ${label} has no package/package.json`)
  }
  return packageDir
}

const findLinks = ({ dir }) => {
  return fs.readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
      return [full]
    }
    return stat.isDirectory() ? findLinks({ dir: full }) : []
  })
}

// A GET with retries for what is worth retrying: network errors, timeouts, 429 and 5xx. A 404 is an
// answer when `allowNotFound`; any other status is an error, not a retry. A `Retry-After` on the
// answer is honoured (at least that long; longer than MAX_RETRY_AFTER_MS fails the read at once), and a body that is not read
// is cancelled so the connection is freed.
const request = async ({ url, accept, maxAttempts, retryBaseMs, allowNotFound }) => {
  for (let attempt = 1; ; attempt++) {
    let failure
    try {
      const response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.status === 404 && allowNotFound) {
        await response.body?.cancel()
        return null
      }
      if (response.ok) {
        return Buffer.from(await response.arrayBuffer())
      }
      await response.body?.cancel()
      failure = { retryable: response.status === 429 || response.status >= 500, message: `answered ${response.status}`, retryAfterMs: parseRetryAfter({ header: response.headers.get('retry-after') }) }
    }
    catch (error) {
      failure = { retryable: true, message: describe({ error }), retryAfterMs: 0 }
    }
    if (failure.retryAfterMs > MAX_RETRY_AFTER_MS) {
      throw new Error(`could not read ${url} (attempt ${attempt}/${maxAttempts}): ${failure.message}; it asks to wait ${Math.round(failure.retryAfterMs / 1000)} s, longer than the ${MAX_RETRY_AFTER_MS / 1000} s this check waits, so the registry is treated as down for this run`)
    }
    if (!failure.retryable || attempt >= maxAttempts) {
      throw new Error(`could not read ${url} (attempt ${attempt}/${maxAttempts}): ${failure.message}`)
    }
    const backoff = Math.pow(4, attempt - 1) * retryBaseMs
    await new Promise((resolve) => setTimeout(resolve, Math.max(backoff, failure.retryAfterMs)))
  }
}

// `Retry-After` as seconds or as an HTTP date; 0 when absent or unreadable.
const parseRetryAfter = ({ header }) => {
  if (header === null || header === undefined) {
    return 0
  }
  if (/^\d+$/.test(header.trim())) {
    return Number(header.trim()) * 1000
  }
  const date = Date.parse(header)
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now())
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
const installedDependencies = ({ manifest, section, exclude = new Set() }) => {
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
