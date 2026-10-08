#!/usr/bin/env node
//
// ADR-0001 gate 1, plus the PR-time half of gate 4 and the bookkeeping changesets needs to be the
// only thing that raises a version. Fails a pull request when:
//
//   1. a file under `<pkg>/src/` of a versioned package changed, or one of its dependency sections
//      in `package.json` changed, and no changeset added in this PR names that package;
//   2. a changeset added in this PR is malformed, names a package that is not in the workspace, or
//      names one that changesets is configured never to version;
//   3. a versioned package's `version` (or the root `package.json`'s) was edited by hand — only the
//      release PR (`changeset-release/*`, opened by .github/workflows/changesets.yml) raises
//      versions, otherwise a hand bump plus a changeset raises the version twice;
//   4. a changeset declares a platform major (`"@aiqadam/platform": major`) and
//      `docs/install/configuration/breaking-changes.mdx` was not modified in the same PR (gate 4;
//      the tag-time half is in check-breaking-change-changelog.sh);
//   5. the root `package.json` version and `packages/platform/package.json` disagree.
//
// "Versioned package" is read from the same place changesets reads it, so the two cannot drift:
// every workspace package from the root `workspaces` globs, minus the names in
// `.changeset/config.json` `ignore`, minus `private` packages unless `privatePackages.version` is
// set. Today that is `@aiqadam/shared`, `qadams-framework`, `qadams-common`, `@aiqadam/platform`
// and the qadams under packages/qadams/{core,community}.
//
// It replaces tools/ci/check-qadam-version-bumps.mjs: a dependency change inside a qadam used to
// demand a hand bump of the qadam's version; under ADR-0001 it demands a changeset, and
// `--write-renovate-changeset` writes that changeset on Renovate's branches
// (.github/workflows/renovate-changeset.yml), which is what qadam-version-bump.yml used to do.
//
// SELF-CONTAINED ON PURPOSE: node builtins only, no install needed. The Renovate workflow runs the
// trusted copy of this one file from the base branch (`git show <base>:tools/ci/...`) before it
// pushes with a token, so it must not import anything from the PR's tree.
//
// WHAT IT CANNOT DO
// - It checks that a changeset NAMES the package, not that the level is right. That is gate 2
//   (check-changeset-levels.mjs).
// - Only changesets added or modified in THIS PR count. A changeset already pending on main for
//   the same package does not cover a second PR's change: each change gets its own changelog line.
// - A `src/` change that is only a test file still counts. Tests live under `test/` in this repo;
//   a spec inside `src/` is a src change.
// - It reads base and head from git, not from the working tree: under the default pull_request
//   checkout the working tree is the merge commit.
//
// ---------------------------------------------------------------------------
// THE ONE DEPENDENCY CHANGE THAT NEEDS NO CHANGESET
// ---------------------------------------------------------------------------
// Removing `@aiqadam/shared`. It is private and no longer published (ADR-0001, #799), qadams may
// not import it (gate 6, packages/qadams/eslint.config.mjs), and the entry was already unused when
// #799 dropped it from all 238 manifests. Demanding a changeset would mean 238 releases with no
// code change, which ADR-0001 and ADR-0003 both reject; each qadam ships the smaller manifest with
// its next real release. Only the removal is exempt: adding the dependency back, or changing its
// spec, still counts as a dependency change, and so does any other entry in the same section.
//
// Usage:
//   PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> node tools/ci/check-changesets.mjs
//   node tools/ci/check-changesets.mjs                      # local: origin/<GITHUB_BASE_REF|main>...HEAD
//   node tools/ci/check-changesets.mjs --write-renovate-changeset
//
// Exit: 0 pass, 1 fail, 2 UNKNOWN (could not measure; a failure, never a pass).
//
// Tested by tools/ci/test-changesets-gate.sh.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const changesetGate = {
  loadWorkspace: (...args) => loadWorkspace(...args),
  readAddedChangesets: (...args) => readAddedChangesets(...args),
  declaredLevels: (...args) => declaredLevels(...args),
  resolveRange: (...args) => resolveRange(...args),
  changedFiles: (...args) => changedFiles(...args),
  owningPackage: (...args) => owningPackage(...args),
  readFileAt: (...args) => readFileAt(...args),
}

const LEVEL_RANK = { none: 0, patch: 1, minor: 2, major: 3 }
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const REMOVABLE_WITHOUT_CHANGESET = ['@aiqadam/shared']
const PLATFORM_PACKAGE = '@aiqadam/platform'
const PLATFORM_DIR = 'packages/platform'
const BREAKING_CHANGES_DOC = 'docs/install/configuration/breaking-changes.mdx'
const RELEASE_BRANCH_PREFIX = 'changeset-release/'
const CHANGESET_DIR = '.changeset'

const main = () => {
  const write = process.argv.includes('--write-renovate-changeset')
  const range = resolveRange()
  const result = tryCatchSync(() => evaluate({ range }))
  if (result.error) {
    console.error(`[check-changesets] UNKNOWN — could not measure ${range.label}: ${result.error.message}`)
    console.error('This is a failure, not a pass. A shallow checkout (needs fetch-depth: 0) or an unreachable SHA is the usual cause.')
    process.exitCode = 2
    return
  }
  const report = result.data
  if (write) {
    writeRenovateChangeset({ report })
    return
  }
  printReport({ report, range })
  process.exitCode = report.failures.length > 0 ? 1 : 0
}

const evaluate = ({ range }) => {
  const workspace = loadWorkspace({ sha: range.head })
  const files = changedFiles({ range })
  const changesets = readAddedChangesets({ range })
  const failures = []

  for (const changeset of changesets) {
    for (const problem of changeset.problems) {
      failures.push(`${changeset.file}: ${problem}`)
    }
    for (const release of changeset.releases) {
      const pkg = workspace.byName.get(release.name)
      if (!pkg) {
        failures.push(`${changeset.file}: names '${release.name}', which is not a package in this workspace`)
      }
      else if (!pkg.versioned) {
        failures.push(`${changeset.file}: names '${release.name}', which .changeset/config.json never versions (ignored or private) — drop it from the changeset`)
      }
    }
  }
  const declared = declaredLevels({ changesets })

  const needs = new Map()
  const versionEdits = []
  const isReleaseBranch = (process.env.GITHUB_HEAD_REF ?? '').startsWith(RELEASE_BRANCH_PREFIX)

  for (const file of files) {
    if (file === 'package.json') {
      if (!isReleaseBranch && versionChanged({ range, file })) {
        versionEdits.push(file)
      }
      continue
    }
    const pkg = owningPackage({ workspace, file })
    if (!pkg || !pkg.versioned) {
      continue
    }
    if (file.startsWith(`${pkg.dir}/src/`)) {
      addReason({ needs, pkg, reason: `src changed (${file})` })
    }
    if (file === `${pkg.dir}/package.json` && existedAtBase({ range, file })) {
      const sections = changedDependencySections({ range, file })
      if (sections.length > 0) {
        addReason({ needs, pkg, reason: `${sections.join(', ')} changed`, dependencyChange: true })
      }
      if (!isReleaseBranch && versionChanged({ range, file })) {
        versionEdits.push(file)
      }
    }
  }

  const missing = [...needs.values()].filter((entry) => !declared.has(entry.pkg.name))
  for (const entry of missing) {
    failures.push(`${entry.pkg.name} (${entry.pkg.dir}) has no changeset in this PR — ${entry.reasons.join('; ')}`)
  }
  for (const file of versionEdits) {
    failures.push(`${file}: "version" was edited by hand. Under ADR-0001 only the release PR raises versions — revert the edit and declare the level in a changeset instead`)
  }

  if (declared.get(PLATFORM_PACKAGE) === 'major' && !files.includes(BREAKING_CHANGES_DOC)) {
    failures.push(`a changeset declares a platform major ("${PLATFORM_PACKAGE}": major) but ${BREAKING_CHANGES_DOC} was not modified in this PR — add the operator-facing entry under "## Unreleased" (gate 4)`)
  }

  const rootVersion = readJsonAt({ sha: range.head, file: 'package.json' })?.version
  const platformVersion = workspace.byName.get(PLATFORM_PACKAGE)?.version
  if (platformVersion === undefined) {
    throw new Error(`${PLATFORM_DIR}/package.json (${PLATFORM_PACKAGE}) is not a workspace package at ${range.head}`)
  }
  if (rootVersion !== platformVersion) {
    failures.push(`root package.json is ${rootVersion} but ${PLATFORM_DIR}/package.json is ${platformVersion} — they must agree (the release PR's version script keeps them in step)`)
  }

  return { failures, needs: [...needs.values()], missing, declared, changesets, files }
}

const printReport = ({ report, range }) => {
  const { failures, needs, declared, changesets } = report
  console.log(`[check-changesets] range ${range.label}: ${changesets.length} changeset(s) added, ${needs.length} versioned package(s) changed`)
  for (const [name, level] of declared) {
    console.log(`  declared  ${name}: ${level}`)
  }
  if (failures.length === 0) {
    console.log('[check-changesets] OK — every changed versioned package has a changeset.')
    return
  }
  console.error(`\n[check-changesets] ${failures.length} problem(s):\n`)
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
    console.error(`::error title=Changesets (ADR-0001 gate 1)::${failure}`)
  }
  console.error('\nAdd a changeset with `npx changeset` (or write .changeset/<name>.md by hand):')
  console.error('\n  ---\n  "@aiqadam/qadam-example": patch\n  ---\n\n  One line on what changed.\n')
  console.error('Levels: ADR-0001 "What each number means". Not a release-worthy change? An empty changeset (`npx changeset --empty`) does not satisfy a src change — name the package.')
}

const writeRenovateChangeset = ({ report }) => {
  const uncovered = report.missing.filter((entry) => entry.dependencyChange && entry.reasons.every((reason) => !reason.startsWith('src changed')))
  if (uncovered.length === 0) {
    console.log('[check-changesets] nothing to write — every dependency change already has a changeset.')
    return
  }
  const slug = (process.env.GITHUB_HEAD_REF ?? 'dependencies').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'dependencies'
  const file = path.join(CHANGESET_DIR, `${slug}.md`)
  const lines = uncovered.map((entry) => `"${entry.pkg.name}": patch`)
  const content = `---\n${lines.join('\n')}\n---\n\nUpdate third-party dependencies (Renovate).\n`
  fs.writeFileSync(file, content)
  console.log(`[check-changesets] wrote ${file} for ${uncovered.length} package(s): ${uncovered.map((entry) => entry.pkg.name).join(', ')}`)
}

const resolveRange = () => {
  const { PR_BASE_SHA, PR_HEAD_SHA, GITHUB_BASE_REF } = process.env
  if (PR_BASE_SHA && PR_HEAD_SHA) {
    return { base: PR_BASE_SHA, head: PR_HEAD_SHA, label: `${PR_BASE_SHA}...${PR_HEAD_SHA}` }
  }
  const base = `origin/${GITHUB_BASE_REF || 'main'}`
  return { base, head: 'HEAD', label: `${base}...HEAD` }
}

// Workspace packages as changesets sees them, read at `sha`. Only the two glob forms the root
// manifest uses (`dir` and `dir/*`) are understood; anything else is UNKNOWN rather than a silent
// under-count.
const loadWorkspace = ({ sha }) => {
  const root = readJsonAt({ sha, file: 'package.json' })
  if (!root || !Array.isArray(root.workspaces)) {
    throw new Error(`root package.json at ${sha} has no "workspaces" array`)
  }
  const config = readJsonAt({ sha, file: `${CHANGESET_DIR}/config.json` })
  if (!config) {
    throw new Error(`${CHANGESET_DIR}/config.json is missing or not JSON at ${sha}`)
  }
  const ignore = new Set(Array.isArray(config.ignore) ? config.ignore : [])
  const versionPrivate = config.privatePackages === true || config.privatePackages?.version === true

  const dirs = root.workspaces.flatMap((pattern) => expandWorkspacePattern({ sha, pattern }))
  const packages = dirs.flatMap((dir) => {
    const manifest = readJsonAt({ sha, file: `${dir}/package.json` })
    if (!manifest || typeof manifest.name !== 'string') {
      return []
    }
    const isPrivate = manifest.private === true
    const versioned = !ignore.has(manifest.name) && (!isPrivate || versionPrivate)
    return [{ name: manifest.name, dir, version: manifest.version, private: isPrivate, versioned }]
  })
  if (packages.length === 0) {
    throw new Error(`no workspace packages found at ${sha}`)
  }
  const unknownIgnores = [...ignore].filter((name) => !packages.some((pkg) => pkg.name === name))
  if (unknownIgnores.length > 0) {
    throw new Error(`${CHANGESET_DIR}/config.json ignores packages that do not exist: ${unknownIgnores.join(', ')}`)
  }
  return { packages, byName: new Map(packages.map((pkg) => [pkg.name, pkg])) }
}

const expandWorkspacePattern = ({ sha, pattern }) => {
  if (!pattern.includes('*')) {
    return [pattern]
  }
  if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
    throw new Error(`workspace pattern '${pattern}' is not of the form <dir> or <dir>/* — this gate does not expand it`)
  }
  const parent = pattern.slice(0, -2)
  const out = gitOrNull({ args: ['ls-tree', '-d', '--name-only', `${sha}:${parent}`] })
  if (out === null || out === '') {
    return []
  }
  return out.split('\n').map((name) => `${parent}/${name}`)
}

const owningPackage = ({ workspace, file }) => {
  return workspace.packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
}

const changedFiles = ({ range }) => {
  const out = git({ args: ['diff', '--name-only', '--no-renames', `${range.base}...${range.head}`] })
  return out === '' ? [] : out.split('\n')
}

// Changesets present at head that this PR added or modified. Deleting one is not declaring one.
const readAddedChangesets = ({ range }) => {
  const out = git({ args: ['diff', '--name-only', '--no-renames', '--diff-filter=AM', `${range.base}...${range.head}`, '--', CHANGESET_DIR] })
  if (out === '') {
    return []
  }
  return out.split('\n')
    .filter((file) => path.posix.dirname(file) === CHANGESET_DIR && file.endsWith('.md') && path.posix.basename(file).toLowerCase() !== 'readme.md')
    .map((file) => {
      const text = readFileAt({ sha: range.head, file })
      if (text === null) {
        throw new Error(`cannot read ${file} at ${range.head}`)
      }
      return { file, ...parseChangeset({ text }) }
    })
}

// The changeset format (https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md):
// a YAML front matter of `"<package>": <level>` lines, then a summary. Parsed strictly — anything
// this does not recognise is reported as a problem rather than skipped, so a typo cannot read as
// "declares nothing".
const parseChangeset = ({ text }) => {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n?---(?:\n|$)([\s\S]*)$/.exec(normalized.replace(/^﻿/, '').trimStart())
  if (!match) {
    return { releases: [], summary: '', problems: ['has no "---" front matter block'] }
  }
  const [, front, body] = match
  const releases = []
  const problems = []
  for (const rawLine of front.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const entry = /^(?:"([^"]+)"|'([^']+)'|([^\s:'"][^\s:]*))\s*:\s*(\S+)\s*$/.exec(line)
    if (!entry) {
      problems.push(`cannot parse front matter line '${line}'`)
      continue
    }
    const name = entry[1] ?? entry[2] ?? entry[3]
    const level = entry[4].replace(/^["']|["']$/g, '')
    if (!['patch', 'minor', 'major', 'none'].includes(level)) {
      problems.push(`'${name}' has level '${level}', expected patch, minor, major or none`)
      continue
    }
    if (releases.some((release) => release.name === name)) {
      problems.push(`'${name}' is listed twice`)
      continue
    }
    releases.push({ name, level })
  }
  const summary = body.trim()
  if (releases.length > 0 && summary === '') {
    problems.push('has no summary line — say what changed, it becomes the changelog entry')
  }
  return { releases, summary, problems }
}

// Highest level declared per package across every changeset added in the range.
const declaredLevels = ({ changesets }) => {
  const declared = new Map()
  for (const { releases } of changesets) {
    for (const { name, level } of releases) {
      const current = declared.get(name)
      if (current === undefined || LEVEL_RANK[level] > LEVEL_RANK[current]) {
        declared.set(name, level)
      }
    }
  }
  return declared
}

const addReason = ({ needs, pkg, reason, dependencyChange = false }) => {
  const entry = needs.get(pkg.name) ?? { pkg, reasons: [], dependencyChange: false }
  const reasons = entry.reasons.length < 3
    ? [...entry.reasons, reason]
    : entry.reasons.length === 3
      ? [...entry.reasons, '…']
      : entry.reasons
  needs.set(pkg.name, { ...entry, reasons, dependencyChange: entry.dependencyChange || dependencyChange })
}

const existedAtBase = ({ range, file }) => readFileAt({ sha: range.base, file }) !== null

const changedDependencySections = ({ range, file }) => {
  const base = readJsonAt({ sha: range.base, file })
  const head = readJsonAt({ sha: range.head, file })
  if (!base || !head) {
    throw new Error(`${file} is not valid JSON at one end of the range`)
  }
  return DEP_SECTIONS.filter((section) => JSON.stringify(sortKeys(withoutExemptRemovals({ before: base[section], after: head[section] }))) !== JSON.stringify(sortKeys(head[section])))
}

// `before` with the exempt entries dropped where `after` no longer has them, so their removal alone
// compares equal (see "THE ONE DEPENDENCY CHANGE THAT NEEDS NO CHANGESET").
const withoutExemptRemovals = ({ before, after }) => {
  if (before === undefined || before === null || typeof before !== 'object') {
    return before
  }
  const removed = REMOVABLE_WITHOUT_CHANGESET.filter((name) => name in before && !(name in (after ?? {})))
  return Object.fromEntries(Object.entries(before).filter(([name]) => !removed.includes(name)))
}

const versionChanged = ({ range, file }) => {
  const base = readJsonAt({ sha: range.base, file })
  const head = readJsonAt({ sha: range.head, file })
  if (!base || !head) {
    return false
  }
  return base.version !== head.version
}

const sortKeys = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value ?? null
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
}

// `stdio: ['ignore', 'pipe', 'pipe']` keeps a failing `git show` from printing "fatal: …" into the
// log when the caller handles the failure (see check-required-prop-defaults.mjs).
const git = ({ args }) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()

const gitOrNull = ({ args }) => {
  const result = tryCatchSync(() => git({ args }))
  return result.error ? null : result.data
}

const readFileAt = ({ sha, file }) => gitOrNull({ args: ['show', `${sha}:${file}`] })

const readJsonAt = ({ sha, file }) => {
  const text = readFileAt({ sha, file })
  if (text === null) {
    return null
  }
  const parsed = tryCatchSync(() => JSON.parse(text))
  return parsed.error ? null : parsed.data
}

const tryCatchSync = (fn) => {
  try {
    return { data: fn(), error: null }
  }
  catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main()
}
