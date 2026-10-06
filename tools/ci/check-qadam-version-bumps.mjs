#!/usr/bin/env node
//
// A dependency change inside a published qadam must be paired with a bump of that qadam's own
// `version`. AGENTS.md ("Published-package version bumps") makes the version a public contract:
// `packagePrePublishChecks` skips a version already on the registry, so a qadam whose dependency
// moved but whose version did not is simply never republished — the fix (often a security one)
// never reaches a consumer, and nothing in CI says so.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A CI DIFF CHECK AND NOT A RENOVATE PACKAGE RULE
// ---------------------------------------------------------------------------
// The gap was found in Renovate's own PRs (#726/#728/#729/#730): a security/OSV alert edits a
// qadam's `package.json` but cannot bump the qadam's `version`. Renovate's `bumpVersion` is
// supported only by the `npm` manager, and this repo has a `bun.lock`, so the `bun` manager
// supersedes `npm` and manages every `package.json` — with no `bumpPackageVersion`, so the rule
// is a silent no-op. `bumpVersions` (plural, manager-agnostic) cannot scope to the changed file:
// its `filePatterns` are matched against the whole repository file list, so a qadam-wide glob
// would bump all ~240 qadams on any update, and `{{packageFileDir}}` reflects only one upgrade in
// a branch that may touch several qadam files.
//
// A git-diff gate has neither problem: it sees exactly the files the change touched, whichever
// manager wrote them. `--fix` is what the `Qadam version bumps` workflow runs on Renovate's own
// branches, so the bot does the bump; the plain check is the floor that stops a human PR from
// landing a dependency change with no version bump at all.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVABLY CANNOT DO
// ---------------------------------------------------------------------------
// - It only compares `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`.
//   A change to any other field (`engines`, `files`, a script) is not a dependency change and is
//   out of scope; that is a deliberate narrowing, not an oversight.
// - It requires the version to INCREASE, not to reach a particular slot. Deciding "is this
//   dependency change breaking for the qadam's consumer?" is not machine-decidable from the diff
//   alone, so `--check` accepts any increase and `--fix` picks patch, or minor when a dependency
//   itself moved a major (a behaviour change is the 0.x breaking slot). A reviewer can still
//   raise the slot; this gate only guarantees the package republishes.
// - `--fix` bumps from the higher of base/head, not from head alone: when `main` already moved the
//   qadam above the branch, bumping head's value could land on a version that is still <= base,
//   which the gate (a base-vs-head diff) would then reject — a second push to converge. Bumping
//   from the maximum guarantees a strictly-greater result in one pass.
// - `--diff-filter=M`: an Added package.json is a brand-new qadam with no "before" to compare
//   against, so it is out of scope. A Deleted one has nothing to republish.
// - A modified qadam package.json that is not valid JSON fails the gate loudly. Reporting it as
//   "checked, all carry a version bump" would be the vacuous-pass shape verification-pitfalls.md
//   warns about.
//
// Usage:
//   PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> node tools/ci/check-qadam-version-bumps.mjs
//   node tools/ci/check-qadam-version-bumps.mjs --fix   # write the bump into the working tree
//   node tools/ci/check-qadam-version-bumps.mjs         # local fallback: origin/<GITHUB_BASE_REF|main>...HEAD
//
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const QADAM_PACKAGE_FILE = /^packages\/qadams\/.*\/package\.json$/
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const main = () => {
  const { fix } = parseArgs({ argv: process.argv.slice(2) })
  const range = resolveRange()

  let files
  try {
    files = changedFiles({ range })
  }
  catch (error) {
    // A `git diff` failure (unreachable SHA, shallow clone with no history for the base ref, …)
    // must not be read as "nothing changed" — that is the vacuous-pass shape
    // .agents/docs/verification-pitfalls.md warns about. Fail loud instead.
    console.error(`[check-qadam-version-bumps] could not diff ${range.label}: ${error instanceof Error ? error.message : String(error)}`)
    console.error('This usually means a shallow checkout (needs fetch-depth: 0) or an unreachable base/head SHA — not that nothing changed.')
    process.exitCode = 1
    return
  }

  // Zero changed qadam package.json files is the ORDINARY case (most PRs touch none), not a sign
  // the scan target moved, so this exits 0 rather than loud-failing like check-dropdown-defaults.mjs.
  if (files.length === 0) {
    console.log(`[check-qadam-version-bumps] OK — no modified qadam package.json in ${range.label}.`)
    return
  }

  const findings = files.flatMap((file) => inspectFile({ file, range }))
  const unparseable = findings.filter((finding) => finding.kind === 'unparseable')
  const bumps = findings.filter((finding) => finding.kind === 'bump')

  if (unparseable.length > 0) {
    console.error(`[check-qadam-version-bumps] ${unparseable.length} modified qadam package.json is not valid JSON — refusing to report a pass:\n`)
    for (const finding of unparseable) {
      console.error(`  ${finding.file} — ${finding.reason}`)
    }
    process.exitCode = 1
    return
  }

  if (fix) {
    // `applyBump` returns null when the working tree no longer holds the version it read from the
    // diff, and reports that itself; filter those out so a failure is not mistaken for a clean run.
    const results = bumps.map((finding) => applyBump({ finding }))
    const bumped = results.filter(Boolean)
    for (const { file, from, to } of bumped) {
      console.log(`[check-qadam-version-bumps] bumped ${file}: ${from} -> ${to}`)
    }
    if (bumped.length === 0 && bumped.length === results.length) {
      console.log(`[check-qadam-version-bumps] OK — checked ${files.length} modified qadam package.json in ${range.label}, nothing to bump.`)
    }
    return
  }

  if (bumps.length === 0) {
    console.log(`[check-qadam-version-bumps] OK — checked ${files.length} modified qadam package.json in ${range.label}, all carry a version bump.`)
    return
  }

  console.error(`[check-qadam-version-bumps] ${bumps.length} qadam package.json changed a dependency without bumping its own version:\n`)
  for (const finding of bumps) {
    console.error(`  ${finding.file} — ${finding.section} changed, but version stayed ${finding.version} (needs ${finding.suggestedBump}: ${finding.version} -> ${finding.newVersion})`)
  }
  console.error('\nA published qadam whose dependency moved must bump its own `version`, or `packagePrePublishChecks` skips it and the change never reaches a consumer (AGENTS.md, "Published-package version bumps"). Run `node tools/ci/check-qadam-version-bumps.mjs --fix` to apply it.')
  process.exitCode = 1
}

const parseArgs = ({ argv }) => {
  const options = { fix: false }
  for (const arg of argv) {
    if (arg === '--fix') {
      options.fix = true
    }
  }
  return options
}

const resolveRange = () => {
  const { PR_BASE_SHA, PR_HEAD_SHA, GITHUB_BASE_REF } = process.env
  if (PR_BASE_SHA && PR_HEAD_SHA) {
    return { base: PR_BASE_SHA, head: PR_HEAD_SHA, label: `${PR_BASE_SHA}...${PR_HEAD_SHA}` }
  }
  const base = `origin/${GITHUB_BASE_REF ?? 'main'}`
  return { base, head: 'HEAD', label: `${base}...HEAD` }
}

// `stdio: ['ignore', 'pipe', 'pipe']` keeps a failing `git show`/`git diff` from printing its raw
// "fatal: …" into the CI log even though the exception is caught — see the same choice in
// check-required-prop-defaults.mjs.
const git = ({ args }) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const changedFiles = ({ range }) => {
  const out = git({ args: ['diff', '--name-only', '--no-renames', '--diff-filter=M', `${range.base}...${range.head}`] })
  if (!out) {
    return []
  }
  return out.split('\n').filter((file) => QADAM_PACKAGE_FILE.test(file))
}

const readFileAt = ({ sha, file }) => {
  try {
    return git({ args: ['show', `${sha}:${file}`] })
  }
  catch {
    return null
  }
}

// Base and head are both read from git, matching check-required-prop-defaults.mjs. The working
// tree is NOT a reliable stand-in for head: under the default `pull_request` checkout it is the
// merge commit, which can carry a version `main` moved on independently of the branch.
const inspectFile = ({ file, range }) => {
  const baseText = readFileAt({ sha: range.base, file })
  const headText = readFileAt({ sha: range.head, file })
  if (baseText === null || headText === null) {
    return []
  }

  const base = safeParse({ text: baseText })
  const head = safeParse({ text: headText })
  if (base === null || head === null) {
    return [{ kind: 'unparseable', file, reason: 'one side is not valid JSON' }]
  }

  const changedSection = DEP_SECTIONS.find((section) => !sameJson({ a: base[section], b: head[section] }))
  if (changedSection === undefined) {
    return []
  }
  if (versionIncreased({ base: base.version, head: head.version })) {
    return []
  }
  // Bump from the higher of the two, so the result is guaranteed > base even when `main` already
  // moved the qadam ahead of the branch (see "WHAT THIS PROVABLY CANNOT DO").
  const fromVersion = maxVersion({ a: base.version, b: head.version })
  if (fromVersion === null) {
    // A version that is not plain `x.y.z` (a prerelease, a workspace marker) cannot be bumped
    // mechanically. Stay silent rather than write a wrong value.
    return []
  }
  const suggestedBump = dependencyMovedMajor({ base, head }) ? 'minor' : 'patch'
  const newVersion = bump({ version: fromVersion, type: suggestedBump })
  if (newVersion === null) {
    return []
  }
  return [{ kind: 'bump', file, section: changedSection, version: head.version, suggestedBump, newVersion }]
}

const applyBump = ({ finding }) => {
  // The working tree is what `--fix` rewrites. In the `Qadam version bumps` workflow it is the
  // checked-out branch, so it holds `finding.version`; if it does not, refuse rather than write.
  const text = fs.readFileSync(finding.file, 'utf-8')
  const next = replaceVersion({ text, from: finding.version, to: finding.newVersion })
  if (next === null) {
    console.error(`[check-qadam-version-bumps] could not rewrite the version in ${finding.file}; leaving it unchanged`)
    process.exitCode = 1
    return null
  }
  fs.writeFileSync(finding.file, next)
  return { file: finding.file, from: finding.version, to: finding.newVersion }
}

const sameJson = ({ a, b }) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

const safeParse = ({ text }) => {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ''))
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null
}

const compareVersions = ({ a, b }) => {
  const before = parseVersion(a)
  const after = parseVersion(b)
  if (before === null || after === null) {
    return null
  }
  if (before.major !== after.major) {
    return before.major < after.major ? -1 : 1
  }
  if (before.minor !== after.minor) {
    return before.minor < after.minor ? -1 : 1
  }
  if (before.patch !== after.patch) {
    return before.patch < after.patch ? -1 : 1
  }
  return 0
}

const versionIncreased = ({ base, head }) => compareVersions({ a: base, b: head }) === -1

const maxVersion = ({ a, b }) => {
  const order = compareVersions({ a, b })
  if (order === null) {
    return null
  }
  return order >= 0 ? a : b
}

// The first numeric component of a dependency spec: `4.20.0`, `^4.20.0`, `~4.20` all start at 4.
const specMajor = (spec) => {
  const match = /^[^\d]*(\d+)/.exec(String(spec ?? ''))
  return match ? Number(match[1]) : null
}

const dependencyMovedMajor = ({ base, head }) => {
  for (const section of DEP_SECTIONS) {
    const before = base[section] ?? {}
    const after = head[section] ?? {}
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = specMajor(before[name])
      const to = specMajor(after[name])
      if (from !== null && to !== null && to > from) {
        return true
      }
    }
  }
  return false
}

const bump = ({ version, type }) => {
  const parsed = parseVersion(version)
  if (parsed === null) {
    return null
  }
  if (type === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

// The package's own `version` key, not the first `"version"` string in the file: a nested key
// (e.g. `publishConfig.version`) can appear earlier and, if it happens to hold the same value,
// would otherwise be the one rewritten — a silent corruption the log still calls a bump. Scans
// for a depth-1 key, skipping string literals so a `{`/`}` inside a value does not skew the depth.
const findTopLevelVersionKey = ({ text }) => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      }
      else if (char === '\\') {
        escaped = true
      }
      else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      if (depth === 1 && text.startsWith('"version"', i) && /^\s*:/.test(text.slice(i + '"version"'.length))) {
        return i
      }
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
    }
    else if (char === '}') {
      depth -= 1
    }
  }
  return -1
}

const replaceVersion = ({ text, from, to }) => {
  const keyIndex = findTopLevelVersionKey({ text })
  if (keyIndex === -1) {
    return null
  }
  const head = text.slice(0, keyIndex)
  const tail = text.slice(keyIndex)
  const match = /^("version"\s*:\s*")([^"]*)(")/.exec(tail)
  // Refuse unless the working tree still holds the version the diff read: `--fix` must not rewrite
  // a value that moved out from under it (a local run on a dirty tree, or a branch that advanced
  // between the event and the checkout).
  if (match === null || match[2] !== from) {
    return null
  }
  return head + `${match[1]}${to}${match[3]}` + tail.slice(match[0].length)
}

main()
