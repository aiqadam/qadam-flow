#!/usr/bin/env node
//
// #479: a prop added to an ALREADY-SHIPPED action or trigger must be optional, or required
// with a `defaultValue` that preserves the previous behaviour. A required prop with no default
// invalidates every flow that was configured before the prop existed — the saved
// `step.settings.input` has no value for a field the schema now demands. The rule itself lives
// in "Versioning an existing piece" in .agents/skills/qadam-builder/SKILL.md; this script is
// the part of #479 that actually enforces it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A DIFF CHECK, NOT A TREE SCAN LIKE check-dropdown-defaults.mjs
// ---------------------------------------------------------------------------
// "Newly required" is a claim about two points in time, not about one tree. The natural source
// for "the previous shipped version" would be a published package (npm) or a git tag per
// release, matching how check-dropdown-defaults.mjs's own header explains its trade-offs.
// Neither exists yet for official qadams as of #479: `git tag -l` on this repo returns zero
// tags, and #476 (publish official qadams to a registry, with historical versions backfilled
// from git tags) is open and blocked by #475 — see #479's own investigation. So there is no
// artifact to diff a qadam's current props against "the last thing a user actually installed".
//
// What DOES exist today, unconditionally, is the pull request's own diff: `_verify.yml` already
// checks out with `fetch-depth: 0` and already threads `PR_BASE_SHA`/`PR_HEAD_SHA` through to
// tools/scripts/check-migration-rollback.ts for exactly this reason. This script reuses that
// same range. It catches a required-prop-with-no-default that a SINGLE pull request introduces
// on a file that already existed before that PR, without also bumping the qadam's own
// package.json major version in the same range — the shape #363's `executionMode` addition
// would have been (see #479 / #411 comment history).
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVABLY CANNOT DO — read before trusting a clean run
// ---------------------------------------------------------------------------
// - It only ever sees ONE pull request's range. A violation split across two separate PRs (PR A
//   adds the prop as optional; PR B, weeks later, flips it to required with no default) IS
//   caught, because PR B's own base->head diff shows that flip. A violation introduced by a
//   direct push to `main` with no pull request is NOT caught — the CI step below only runs
//   `if: github.event_name == 'pull_request'`, the same scope limit the migration-metadata gate
//   already accepts for the same reason.
// - It cannot see across files. A prop assigned from a helper call
//   (`chat_id: telegramCommons.chatIdProp()`, common in this codebase — see
//   packages/qadams/community/telegram-bot) or from a spread/imported constant is left
//   unresolved and silently skipped, the same "stay silent rather than guess" doctrine
//   check-dropdown-defaults.mjs documents for its own non-literal cases. A real violation
//   hidden behind such a helper is invisible to this script.
// - It only reads a `required`/`defaultValue` pair that is a literal directly inside a
//   `Property.X({ ... })` / `QadamAuth.X({ ... })`-shaped call. A non-literal `required` (e.g.
//   `required: someFlag`) makes the whole prop entry unresolvable, not "assumed required" or
//   "assumed optional" — skipped either way.
// - It does not audit the tree for violations that predate this script. Unlike
//   check-dropdown-defaults.mjs (a full-tree scan that catches every existing mismatch, however
//   old), this is a diff gate: it only stops a NEW instance of the shape from landing. A required
//   prop with no default that already shipped before this check existed will never be flagged
//   retroactively.
// - Bumping the major version is treated as sufficient to pass. This script does not verify the
//   bump is accompanied by a migration path, a changelog entry, or that `minimumSupportedRelease`
//   was reconsidered — only that the numeric major component of the qadam's own package.json
//   increased in the same range. That is the same bar "Versioning an existing piece" already sets
//   for this case; this script does not raise that bar, only enforces it mechanically.
//
// A gate that scans the FULL tree unconditionally (as opposed to a diff) would be simpler, but
// would either flag every already-shipped required-no-default prop in the repo today (a false
// positive on every one of them, since "shipped before this check existed" is not "introduced by
// you") or would need the very artifact (previous published version) that #476 has not produced
// yet. This diff-scoped shape is the strongest sound check available without #476; if #476 lands,
// diffing against the actually-published previous version (rather than this PR's own base) would
// close the "split across two separate PRs with no version check in between" gap this script
// still has in principle (in practice, per the point above, that gap does not exist for a
// two-PR split — it exists only for a change that landed with no pull request at all).
//
// Usage:
//   PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> node tools/ci/check-required-prop-defaults.mjs
//   node tools/ci/check-required-prop-defaults.mjs   # local fallback: origin/<GITHUB_BASE_REF|main>...HEAD
//
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const QADAM_ROOTS = ['packages/qadams/community', 'packages/qadams/core', 'packages/qadams/common']
const CREATE_FACTORIES = new Set(['createAction', 'createTrigger'])
const NOT_STATIC = Symbol('not-static')

const main = () => {
  const range = resolveRange()

  let files
  try {
    files = changedFiles({ range })
  }
  catch (error) {
    // A `git diff` failure (unreachable SHA, shallow clone with no history for the base ref, …)
    // must not be read as "nothing changed" — that is exactly the vacuous-pass shape
    // .agents/docs/verification-pitfalls.md warns about. Fail loud instead.
    console.error(`[check-required-prop-defaults] could not diff ${range.label}: ${error instanceof Error ? error.message : String(error)}`)
    console.error('This usually means a shallow checkout (needs fetch-depth: 0) or an unreachable base/head SHA — not that nothing changed.')
    process.exitCode = 1
    return
  }

  // Unlike check-dropdown-defaults.mjs, zero matched files here is the ORDINARY case (most PRs
  // touch no qadam action/trigger file at all), not a sign the scan target moved — so this exits
  // 0, not loud-fails. Do not "fix" this to mirror the other script's empty-scan guard.
  if (files.length === 0) {
    console.log(`[check-required-prop-defaults] OK — no modified qadam action/trigger files in ${range.label}.`)
    return
  }

  const violations = files.flatMap((file) => checkFile({ file, range }))

  if (violations.length === 0) {
    console.log(`[check-required-prop-defaults] OK — checked ${files.length} modified file(s) in ${range.label}, no unversioned newly-required prop found.`)
    return
  }

  console.error(`[check-required-prop-defaults] ${violations.length} newly-required prop(s) with no default, not paired with a major bump:\n`)
  for (const violation of violations) {
    console.error(`  ${violation.file} — prop '${violation.propKey}' on ${violation.factory}() became required with no defaultValue, but ${violation.packageJsonPath} stayed at a non-major bump (${violation.baseVersion} -> ${violation.headVersion})`)
  }
  console.error('\nEither give the prop a `defaultValue` that preserves the previous behaviour, drop `required: true`, or bump the qadam\'s MAJOR version in this same change — see "Versioning an existing piece" in .agents/skills/qadam-builder/SKILL.md.')
  process.exitCode = 1
}

const resolveRange = () => {
  const { PR_BASE_SHA, PR_HEAD_SHA, GITHUB_BASE_REF } = process.env
  if (PR_BASE_SHA && PR_HEAD_SHA) {
    return { base: PR_BASE_SHA, head: PR_HEAD_SHA, label: `${PR_BASE_SHA}...${PR_HEAD_SHA}` }
  }
  const base = `origin/${GITHUB_BASE_REF ?? 'main'}`
  return { base, head: 'HEAD', label: `${base}...HEAD` }
}

const git = ({ args }) => execFileSync('git', args, { encoding: 'utf-8' }).trim()

// Modified files only — a file git reports as Added has no "before" this diff can compare
// against, so any required-no-default prop in it is a brand-new action/trigger, not one that
// already shipped. --no-renames matches tools/scripts/check-migration-rollback.ts's own choice
// for the same reason: a rename with content changes still needs a real "before" and "after".
const changedFiles = ({ range }) => {
  const out = git({ args: ['diff', '--name-only', '--no-renames', '--diff-filter=M', `${range.base}...${range.head}`] })
  if (!out) {
    return []
  }
  return out.split('\n')
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts'))
    .filter((file) => QADAM_ROOTS.some((root) => file.startsWith(`${root}/`)))
}

const readFileAt = ({ sha, file }) => {
  try {
    return git({ args: ['show', `${sha}:${file}`] })
  }
  catch {
    return null
  }
}

const checkFile = ({ file, range }) => {
  const headText = readFileAt({ sha: range.head, file })
  const baseText = readFileAt({ sha: range.base, file })
  if (headText === null || baseText === null) {
    // File genuinely modified per git, yet unreadable at one end (shouldn't happen for `M`, but
    // an unreadable end means we cannot compare, so stay silent rather than guess).
    return []
  }

  const headProps = extractProps({ text: headText, file })
  const baseProps = extractProps({ text: baseText, file })

  const violations = []
  for (const [propKey, headProp] of headProps) {
    if (!isNewlyRequiredWithoutDefault({ baseProp: baseProps.get(propKey), headProp })) {
      continue
    }

    const packageJsonPath = findPackageJson({ file })
    if (!packageJsonPath) {
      continue // no package.json found under a QADAM_ROOTS entry — can't check version, stay silent
    }
    const { majored, baseVersion, headVersion } = checkMajorBump({ packageJsonPath, range })
    if (majored) {
      continue
    }

    violations.push({ file, propKey, factory: headProp.factory, packageJsonPath, baseVersion, headVersion })
  }
  return violations
}

const isNewlyRequiredWithoutDefault = ({ baseProp, headProp }) => {
  if (!headProp.resolvable || !headProp.required || headProp.hasDefault) {
    return false // head isn't in the shape this check cares about
  }
  if (baseProp === undefined) {
    return true // genuinely new prop key, required, no default
  }
  if (!baseProp.resolvable) {
    return false // can't tell whether this changed — stay silent rather than guess
  }
  if (baseProp.required && !baseProp.hasDefault) {
    return false // already broken before this diff; not introduced by it
  }
  return true // was optional, or had a default, and lost that in this diff
}

const findPackageJson = ({ file }) => {
  const root = QADAM_ROOTS.find((candidate) => file.startsWith(`${candidate}/`))
  if (!root) {
    return null
  }
  const remainder = file.slice(root.length + 1)
  const qadamDirName = remainder.split('/')[0]
  return `${root}/${qadamDirName}/package.json`
}

const checkMajorBump = ({ packageJsonPath, range }) => {
  const baseVersion = readVersion({ sha: range.base, packageJsonPath })
  const headVersion = readVersion({ sha: range.head, packageJsonPath })
  if (baseVersion === null || headVersion === null) {
    return { majored: false, baseVersion: baseVersion ?? 'unreadable', headVersion: headVersion ?? 'unreadable' }
  }
  const baseMajor = Number(baseVersion.split('.')[0])
  const headMajor = Number(headVersion.split('.')[0])
  const majored = Number.isFinite(baseMajor) && Number.isFinite(headMajor) && headMajor > baseMajor
  return { majored, baseVersion, headVersion }
}

const readVersion = ({ sha, packageJsonPath }) => {
  const text = readFileAt({ sha, file: packageJsonPath })
  if (text === null) {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return typeof parsed.version === 'string' ? parsed.version : null
  }
  catch {
    return null
  }
}

// Returns a Map<propKey, { required, hasDefault, resolvable, factory }>. Only
// `Property.X({...})` / `QadamAuth.X({...})`-shaped literal calls are resolvable; anything else
// (a helper call like `telegramCommons.chatIdProp()`, a spread, an imported constant) is recorded
// as unresolvable rather than guessed at.
const extractProps = ({ text, file }) => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const props = new Map()

  const visit = (node) => {
    const factoryCall = asCreateFactoryCall({ node })
    if (factoryCall) {
      for (const [key, value] of readPropsObject({ objectLiteral: factoryCall.configObject, factory: factoryCall.factory })) {
        props.set(key, value)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return props
}

const asCreateFactoryCall = ({ node }) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !CREATE_FACTORIES.has(node.expression.text)) {
    return null
  }
  const [arg] = node.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return null
  }
  return { configObject: arg, factory: node.expression.text }
}

const readPropsObject = ({ objectLiteral, factory }) => {
  const propsProperty = findProperty({ objectLiteral, name: 'props' })
  if (!propsProperty || !ts.isObjectLiteralExpression(propsProperty.initializer)) {
    return []
  }

  return propsProperty.initializer.properties
    .filter((property) => ts.isPropertyAssignment(property) && property.name)
    .map((property) => [property.name.getText(), readPropShape({ initializer: property.initializer, factory })])
}

const readPropShape = ({ initializer, factory }) => {
  if (!ts.isCallExpression(initializer)) {
    return { resolvable: false, required: false, hasDefault: false, factory }
  }
  const [arg] = initializer.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return { resolvable: false, required: false, hasDefault: false, factory }
  }

  const requiredProperty = findProperty({ objectLiteral: arg, name: 'required' })
  const required = readBooleanLiteral({ node: requiredProperty?.initializer })
  if (requiredProperty && required === NOT_STATIC) {
    // `required` is present but not a literal true/false (e.g. a variable) — can't be sure
    // either way, so stay silent rather than assume required or assume optional.
    return { resolvable: false, required: false, hasDefault: false, factory }
  }

  const hasDefault = Boolean(findProperty({ objectLiteral: arg, name: 'defaultValue' }))
  return { resolvable: true, required: required === true, hasDefault, factory }
}

const findProperty = ({ objectLiteral, name }) => {
  return objectLiteral.properties.find((property) => ts.isPropertyAssignment(property) && property.name?.getText() === name)
}

const readBooleanLiteral = ({ node }) => {
  if (!node) {
    return false
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  return NOT_STATIC
}

main()
