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
// on an action/trigger that already existed before that PR, without also bumping the qadam's own
// package.json major version in the same range.
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
// - It cannot see across files. A prop assigned from a helper call outside the `Property.*` /
//   `QadamAuth.*` namespaces (`chat_id: telegramCommons.chatIdProp()`, common in this codebase —
//   see packages/qadams/community/telegram-bot) is recorded unresolvable and skipped, the same
//   "stay silent rather than guess" doctrine check-dropdown-defaults.mjs documents for its own
//   non-literal cases. A real violation hidden behind such a helper is invisible to this script.
//   Measured cost: an AST sweep of every `createAction`/`createTrigger` prop in the tree found
//   ~210 props (~4% of statically-visible props) assigned from such a call with an object-literal
//   argument — resolvable before this namespace check existed, unresolvable now. Some of those are
//   genuinely authoritative forwards, e.g. `community/clockify/src/lib/common/props.ts`'s
//   `workspaceId = (params) => Property.Dropdown({ ..., required: params.required, ... })`: a call
//   site like `workspaceId({ required: true })` with no default, on a prop that used to be
//   `required: false`, is a real violation this script cannot see. Deliberate trade-off, not an
//   oversight — the alternative is resolving through an arbitrary call graph, which is exactly the
//   "guess" this script's whole design refuses to do.
// - Within a `Property.X({ ... })` / `QadamAuth.X({ ... })` call, a spread anywhere in that
//   config object (`Property.ShortText({ ...base, required: true })`), or an ES6 shorthand
//   `{ required }` / `{ defaultValue }`, makes the whole prop entry unresolvable rather than
//   guessed at — either could carry a `required`/`defaultValue` this script cannot see the value
//   of. A plain non-literal `required: someFlag` is unresolvable the same way.
// - A spread at the `props: { ... }` level itself (`props: { ...commonProps, mode: Property.X(...) }`
//   — ~44 occurrences today, e.g. every action in `community/google-sheets` and `community/flowlu`)
//   silently drops whatever keys the spread contributes; only the explicitly-listed sibling keys in
//   that same object are compared. This is a pure under-report (the safe direction): a real
//   violation inside `commonProps` is invisible, but an explicit sibling key is still checked
//   correctly and cannot be turned into a false positive by the spread's presence.
// - A `props:` value that is not an object literal at all (`props: getConvertFileProps()` —
//   ~22 occurrences today, e.g. `community/cloudconvert`, `community/zoho-campaigns`,
//   `community/microsoft-365-people`, `community/assemblyai`) makes the WHOLE action's props
//   unresolvable, and the action is skipped entirely at that end. This one needed an actual code
//   fix, not just a note: treating a non-literal `props:` as "zero props" would have been a false
//   positive machine — if BASE has `props: getProps()` and HEAD later inlines that same helper's
//   return value as a literal, every key in HEAD's literal would look brand-new against BASE's
//   empty read, and any required-no-default prop among them would be flagged incorrectly. Instead,
//   `readPropsObject` reports unresolvable for the whole action, and `checkFile` skips the pairing
//   entirely when either end is unresolvable this way — silence, not a guess, in either direction.
// - It cannot identify an action/trigger with no statically-literal `name: '...'` field UNLESS an
//   enclosing `const`/`function` declaration gives it one — e.g.
//   `export const clickupRegisterTrigger = ({ name }) => createTrigger({ name: \`clickup_trigger_${name}\`, ... })`
//   is keyed by `clickupRegisterTrigger`, since the dynamic `name:` value can never be read
//   statically but the enclosing binding is a stable, real identity for that single `createTrigger`
//   call site across base and head. Only a factory call with neither a literal `name:` NOR an
//   enclosing variable/function declaration (e.g. one passed inline as an array element with no
//   assignment at all) is skipped entirely.
// - `packages/qadams/common` is NOT scanned, unlike check-dropdown-defaults.mjs, which scans it
//   safely because it never needs a per-qadam package version. `common` is a single shared
//   package (`@aiqadam/qadams-common`), not one subdirectory per qadam like `community`/`core` —
//   there is no `<qadamDir>/package.json` under it to check a major bump against. An earlier
//   version of this script inherited check-dropdown-defaults.mjs's QADAM_ROOTS verbatim and
//   mis-derived `packages/qadams/common/src/package.json` (which does not exist) for every prop
//   in it, e.g. the `createAction` in `packages/qadams/common/src/lib/helpers/index.ts` — always
//   failing to resolve a version and (before this comment's fix) treating that as a violation. A
//   required-no-default prop added there is invisible to this check; it needs a scanner that
//   understands `common` has one version for the whole directory, not one that reads each of its
//   `Property.X(...)` declarations as belonging to some subdirectory's own qadam.
// - It does not audit the tree for violations that predate this script. Unlike
//   check-dropdown-defaults.mjs (a full-tree scan that catches every existing mismatch, however
//   old), this is a diff gate: it only stops a NEW instance of the shape from landing. A required
//   prop with no default that already shipped before this check existed will never be flagged
//   retroactively.
// - Bumping the major version is treated as sufficient to pass. This script does not verify the
//   bump is accompanied by a migration path, a changelog entry, or that `minimumSupportedRelease`
//   was reconsidered — only that the numeric major component of the qadam's own package.json
//   increased in the same range. That is the same bar "Versioning an existing piece" already sets
//   for this case; this script does not raise that bar, only enforces it mechanically. If the
//   qadam's `package.json` cannot be read at either end of the range, the prop is skipped rather
//   than flagged — "cannot tell" must never resolve to "violation" any more than to "clean".
// - `defaultValue: undefined`, `defaultValue: null`, `defaultValue: void 0`, and `defaultValue: ''`
//   do NOT count as "has a default": each one leaves a flow authored before the prop existed
//   exactly as unconfigured as having no `defaultValue` key at all, so treating any of them as
//   satisfying the rule would defeat the rule's own purpose. `''` is included on purpose, for
//   consistency with AGENTS.md's existing treatment of an empty string as an "unset" sentinel for
//   `StaticDropdown` defaults — the same reasoning applies here: a required prop whose "default" is
//   an empty string leaves a text field just as unconfigured as no default at all.
//
// ---------------------------------------------------------------------------
// MUTATIONS THAT SURVIVE THE SELF-TEST SUITE ON PURPOSE
// ---------------------------------------------------------------------------
// tools/ci/test-required-prop-defaults-check.sh's own header explains the two guards below and
// why breaking them deliberately does NOT turn the suite red — both are provably redundant given
// this script's own invariants, not undetected gaps. Recorded here too so this header and that
// suite's header can never drift into disagreeing about which mutations are "caught":
// - `headProp.resolvable` in `isNewlyRequiredWithoutDefault` — every unresolvable-return path in
//   `readPropShape` hard-codes `required: false` alongside `resolvable: false`, so `!headProp.required`
//   alone already excludes every unresolvable `headProp`.
// - `--diff-filter=M` in `changedFiles` — every git status other than `M` guarantees the file is
//   missing at one end (Added → missing at base, Deleted → missing at head), and `checkFile`'s
//   `headText === null || baseText === null` guard already returns `[]` for that. The filter is
//   not purely a performance shortcut, though: without it, a diff containing an unrelated Added
//   file would inflate the "checked N modified file(s)" count in a clean run's own log, which is a
//   real (if minor) accuracy cost independent of correctness.
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

// `common` deliberately excluded — see "WHAT THIS PROVABLY CANNOT DO" above.
const QADAM_ROOTS = ['packages/qadams/community', 'packages/qadams/core']
const CREATE_FACTORIES = new Set(['createAction', 'createTrigger'])
const ALLOWED_PROPERTY_NAMESPACES = new Set(['Property', 'QadamAuth'])
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
    console.error(`  ${violation.file} — prop '${violation.propKey}' on ${violation.factory}('${violation.actionName}') became required with no defaultValue, but ${violation.packageJsonPath} stayed at a non-major bump (${violation.baseVersion} -> ${violation.headVersion})`)
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

// `stdio: ['ignore', 'pipe', 'pipe']` is load-bearing, not cosmetic: execFileSync's default stdio
// both INHERITS stderr (so a failing `git show`/`git diff` prints its raw "fatal: …" straight into
// the CI log even though the exception is caught below) and captures it into `error.stderr`/
// `error.message`. Piping instead of inheriting keeps the second without the first.
const git = ({ args }) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// Modified files only — a file git reports as Added has no "before" this diff can compare
// against, so any required-no-default prop in it is a brand-new action/trigger, not one that
// already shipped. (A brand-new action/trigger added to an otherwise-Modified file is a second,
// narrower version of the same case — handled in checkFile via per-action identity, not here.)
// --no-renames matches tools/scripts/check-migration-rollback.ts's own choice for the same
// reason: a rename with content changes still needs a real "before" and "after".
//
// This filter is deliberately redundant with checkFile's own `readFileAt`-null guard below (every
// non-M status guarantees the file is missing at one end, which that guard already handles) — see
// "MUTATIONS THAT SURVIVE ON PURPOSE" above for why removing it does not, on its own, produce a
// wrong answer. It stays for a real but smaller reason: without it, an Added/Deleted file dilutes
// the "checked N modified file(s)" count a clean run reports, which is a log-accuracy concern, not
// a correctness one.
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

  const headActions = extractActions({ text: headText, file })
  const baseActions = extractActions({ text: baseText, file })

  const violations = []
  for (const [actionName, headAction] of headActions) {
    const baseAction = baseActions.get(actionName)
    if (baseAction === undefined) {
      // This action/trigger itself did not exist at BASE — brand new, even though it landed in a
      // file git calls Modified (e.g. a second action appended to an existing file). Nothing to
      // compare against, and nothing "already shipped" to protect, so it is out of scope.
      continue
    }
    if (!headAction.resolvable || !baseAction.resolvable) {
      // The whole `props:` value isn't a literal object at one end (e.g. `props: getProps()`).
      // Treating that as "zero props" would be a false-positive machine — see the `props:` bullet
      // in this file's header — so the entire action is skipped, not just individually missing keys.
      continue
    }

    for (const [propKey, headProp] of headAction.props) {
      if (!isNewlyRequiredWithoutDefault({ baseProp: baseAction.props.get(propKey), headProp })) {
        continue
      }

      const packageJsonPath = findPackageJson({ file })
      const versionCheck = checkMajorBump({ packageJsonPath, range })
      if (!versionCheck.resolvable || versionCheck.majored) {
        // Either the version pairing genuinely can't be read (stay silent, don't guess a
        // violation from missing data) or it WAS majored (the author already paid the cost this
        // rule asks for).
        continue
      }

      violations.push({
        file,
        actionName,
        propKey,
        factory: headProp.factory,
        packageJsonPath,
        baseVersion: versionCheck.baseVersion,
        headVersion: versionCheck.headVersion,
      })
    }
  }
  return violations
}

const isNewlyRequiredWithoutDefault = ({ baseProp, headProp }) => {
  // `!headProp.resolvable` is provably redundant with `!headProp.required` here — readPropShape
  // always pairs `resolvable: false` with `required: false` — kept for defensive symmetry with
  // the `baseProp.resolvable` check below, which IS load-bearing. See "MUTATIONS THAT SURVIVE ON
  // PURPOSE" in this file's header.
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

// `file` is guaranteed (by construction) to start with one of QADAM_ROOTS — changedFiles() only
// ever returns files that already passed this exact `QADAM_ROOTS.some(...)` check, so `root` can
// never be undefined here.
const findPackageJson = ({ file }) => {
  const root = QADAM_ROOTS.find((candidate) => file.startsWith(`${candidate}/`))
  const remainder = file.slice(root.length + 1)
  const qadamDirName = remainder.split('/')[0]
  return `${root}/${qadamDirName}/package.json`
}

const checkMajorBump = ({ packageJsonPath, range }) => {
  const baseVersion = readVersion({ sha: range.base, packageJsonPath })
  const headVersion = readVersion({ sha: range.head, packageJsonPath })
  if (baseVersion === null || headVersion === null) {
    return { resolvable: false, majored: false, baseVersion, headVersion }
  }
  const baseMajor = Number(baseVersion.split('.')[0])
  const headMajor = Number(headVersion.split('.')[0])
  if (!Number.isFinite(baseMajor) || !Number.isFinite(headMajor)) {
    return { resolvable: false, majored: false, baseVersion, headVersion }
  }
  return { resolvable: true, majored: headMajor > baseMajor, baseVersion, headVersion }
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

// Returns a Map<actionName, { resolvable, props: Map<propKey, { required, hasDefault, resolvable,
// factory }> }>, keyed by the action/trigger's own literal `name:` (falling back to an enclosing
// `const`/`function` declaration's identifier — see asCreateFactoryCall) rather than by file, so
// two factories in the same file can never collide and a brand-new action/trigger can be told
// apart from one that already shipped. A factory call with neither identity is skipped entirely —
// see readPropShape's own doc comment for the same "stay silent" doctrine applied one level up.
const extractActions = ({ text, file }) => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const actions = new Map()

  const visit = (node) => {
    const factoryCall = asCreateFactoryCall({ node })
    if (factoryCall) {
      actions.set(factoryCall.actionName, readPropsObject({ objectLiteral: factoryCall.configObject, factory: factoryCall.factory }))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return actions
}

const asCreateFactoryCall = ({ node }) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !CREATE_FACTORIES.has(node.expression.text)) {
    return null
  }
  const [arg] = node.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return null
  }

  const nameProperty = findProperty({ objectLiteral: arg, name: 'name' })
  if (nameProperty && ts.isStringLiteralLike(nameProperty.initializer)) {
    return { configObject: arg, factory: node.expression.text, actionName: nameProperty.initializer.text }
  }

  const enclosingName = findEnclosingDeclarationName({ node })
  if (enclosingName !== null) {
    // Namespaced separately from literal `name:` values so an (extremely unlikely) string
    // collision between an enclosing identifier and some other action's literal name can never
    // merge two unrelated actions under one key.
    return { configObject: arg, factory: node.expression.text, actionName: `decl:${enclosingName}` }
  }

  // Neither a literal `name:` nor an enclosing variable/function identity — comparing this
  // action's props across base/head would risk pairing the wrong two calls, so stay silent.
  return null
}

// Walks up from a `createAction`/`createTrigger` call to the nearest enclosing `const`/`let`/`var`
// declaration or named function declaration, e.g. `export const clickupRegisterTrigger = ({ name })
// => createTrigger({ name: \`clickup_trigger_${name}\`, ... })` resolves to `clickupRegisterTrigger`.
// Requires the source file to have been parsed with `setParentNodes: true` (it is, in extractActions).
const findEnclosingDeclarationName = ({ node }) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text
    }
  }
  return null
}

const readPropsObject = ({ objectLiteral, factory }) => {
  const propsProperty = findProperty({ objectLiteral, name: 'props' })
  if (!propsProperty || !ts.isObjectLiteralExpression(propsProperty.initializer)) {
    // The whole `props:` value isn't a literal object (e.g. `props: getConvertFileProps()`) — we
    // cannot enumerate what it contains in either direction. Reporting "zero props" here would be
    // unsafe (see the `props:` bullet in this file's header for the false-positive it would cause),
    // so the caller must skip the whole action rather than trust an empty Map.
    return { resolvable: false, props: new Map() }
  }

  const props = new Map(
    propsProperty.initializer.properties
      .filter((property) => ts.isPropertyAssignment(property) && property.name)
      .map((property) => [property.name.getText(), readPropShape({ initializer: property.initializer, factory })]),
  )
  return { resolvable: true, props }
}

// Only a call whose callee is `Property.X` or `QadamAuth.X` — with an object-literal argument
// that contains no spread and no `required`/`defaultValue` shorthand — is resolvable. Everything
// else (a helper call like `telegramCommons.chatIdProp()`, a spread that could carry either key
// from elsewhere, an imported constant) is recorded unresolvable rather than guessed at.
const readPropShape = ({ initializer, factory }) => {
  const unresolvable = { resolvable: false, required: false, hasDefault: false, factory }

  if (!ts.isCallExpression(initializer) || !isAllowedPropertyFactoryCallee({ expression: initializer.expression })) {
    return unresolvable
  }
  const [arg] = initializer.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg) || hasUnresolvableHazard({ objectLiteral: arg })) {
    return unresolvable
  }

  const requiredProperty = findProperty({ objectLiteral: arg, name: 'required' })
  const required = readBooleanLiteral({ node: requiredProperty?.initializer })
  if (requiredProperty && required === NOT_STATIC) {
    // `required` is present but not a literal true/false (e.g. a variable) — can't be sure
    // either way, so stay silent rather than assume required or assume optional.
    return unresolvable
  }

  return { resolvable: true, required: required === true, hasDefault: hasResolvableDefaultValue({ objectLiteral: arg }), factory }
}

const isAllowedPropertyFactoryCallee = ({ expression }) => {
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && ALLOWED_PROPERTY_NAMESPACES.has(expression.expression.text)
}

// A spread could silently carry a `required`/`defaultValue` this script never sees the value of;
// an ES6 shorthand (`{ required }` / `{ defaultValue }`) references an identifier, not a literal,
// same as `required: someFlag` already stays unresolvable for.
const hasUnresolvableHazard = ({ objectLiteral }) => {
  return objectLiteral.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      return true
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const shorthandName = property.name.text
      return shorthandName === 'required' || shorthandName === 'defaultValue'
    }
    return false
  })
}

const findProperty = ({ objectLiteral, name }) => {
  return objectLiteral.properties.find((property) => ts.isPropertyAssignment(property) && property.name?.getText() === name)
}

// Presence alone isn't enough: `defaultValue: undefined`, `null`, `void 0`, and `''` all leave a
// flow authored before the prop existed exactly as unconfigured as omitting the key entirely. `''`
// is included for consistency with AGENTS.md's existing "empty string is an unset sentinel"
// treatment of `StaticDropdown` defaults.
const hasResolvableDefaultValue = ({ objectLiteral }) => {
  const defaultValueProperty = findProperty({ objectLiteral, name: 'defaultValue' })
  if (!defaultValueProperty) {
    return false
  }
  const { initializer } = defaultValueProperty
  if (initializer.kind === ts.SyntaxKind.NullKeyword) {
    return false
  }
  if (ts.isIdentifier(initializer) && initializer.text === 'undefined') {
    return false
  }
  if (ts.isVoidExpression(initializer)) {
    return false
  }
  if (ts.isStringLiteralLike(initializer) && initializer.text === '') {
    return false
  }
  return true
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
