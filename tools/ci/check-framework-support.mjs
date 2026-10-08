#!/usr/bin/env node
//
// Gate 8 of ADR-0002 (adr/0002-two-framework-majors-supported-for-at-least-12-months.md): the
// framework support table.
//
// The engine runs qadams built against older frameworks through context shims: a dedicated
// branch per older `ContextVersion` (`makeActionContextBackwardCompatible` in
// packages/qadams/framework/src/lib/context/versioning.ts, `getConnectionValue` in the engine's
// connection resolver). Until ADR-0002 the only thing standing between those shims and their
// removal was a date in a comment (#775). Removing one while stored flows still pin a qadam that
// needs it breaks those flows at run time, on someone's instance, with no warning first.
//
// The support table (packages/qadams/framework/src/lib/context/framework-support-table.json)
// records, per framework major, the context versions its qadams report, its release date and the
// release date of the major after it. A major is SUPPORTED while it is the current or the previous
// released major, and for at least 12 months after its successor was released. This gate fails when:
//
//   1. the table is malformed or disagrees with the code — a gap in the majors, a successor date
//      that is not the next row's release date, a missing release date, or LATEST_CONTEXT_VERSION
//      missing from the current major's row (a new context version is a new framework major);
//   2. the framework major in packages/qadams/framework/package.json has no row ("a framework
//      major is released without a row");
//   3. a context shim a supported major needs is missing from the dispatcher — checked on the
//      tree, so it holds on every run, not only on pull requests;
//   4. against the PR base (PR_BASE_SHA or --base):
//      a. the PR rewrites the table's history — deletes a row, changes a row's contextVersions,
//         changes a recorded date, or fills in a date that is before the base commit or after
//         today. The table decides which shims are owed; without this a PR could narrow a row or
//         backdate a release and delete the shim in the same diff;
//      b. a context shim was removed anywhere in the framework or the engine while a supported
//         major needs it — a deleted branch cannot be seen on the tree alone;
//   5. an official qadam (packages/qadams/{core,community}) is built against a framework major the
//      engine no longer supports: a major with no row, or one whose shims the engine has dropped.
//
// "Released" is the major in packages/qadams/framework/package.json, because that is what the
// official qadams in the tree are built against and publish with. A prerelease of a new major
// (`2.0.0-rc.1`, `2.0.0-next.3`) needs its row, but with `released: null`: it is not a release,
// so it does not start the previous major's 12-month window, and the major before it stays the
// current one for the window. A prerelease inside a released major (`1.3.0-next.0`) is that major.
//
// ---------------------------------------------------------------------------
// DETERMINISTIC AND MONOTONIC
// ---------------------------------------------------------------------------
// No network, no registry, no stored data: the inputs are the tree, the PR base and today's date
// (UTC; `--now` pins it for the fixture tests). The date is read in two places, and in both a
// later date can only turn a failure into a pass: whether a major is still inside its 12-month
// window (a later date shrinks the supported set, so it only allows removals — checks 3 and 4b),
// and whether a date filled in by the PR is after today (4a). It never makes code that passed
// fail. Checks 1, 2 and 5 do not read the date; check 5 asks what the engine still handles, not
// what the calendar allows, for exactly that reason.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVABLY CANNOT DO
// ---------------------------------------------------------------------------
// - Without a base (push to main, tags) checks 4a and 4b do not run. Every change reaches main
//   through a PR, where they did.
// - Inside the window check 4a allows (base commit − 1 day … today + 1 day), a date the PR fills
//   in is the author's word. Review has to confirm it is the day the release happened.
// - A table that is not on the base yet (the PR that introduces it) has no history to compare.
// - It recognises a shim by its shape: a `case ContextVersion.X:` / `case undefined:` in a
//   `switch` that branches on a context version, or an equality test against `ContextVersion.X`,
//   `undefined` or `isNil(...)` on something named like `contextVersion`, in
//   packages/qadams/framework/src and packages/server/engine/src. A shim kept by shape but emptied
//   (its branch now does what the default does) is not detected; review has to catch that.
// - Check 4b compares how many shim sites handle each context version before and after the PR —
//   net counts, not identities. So moving a branch to another file or function passes, and
//   merging two sites into one fails (deliberately: the gate errs towards keeping a shim). The
//   price of letting moves pass: deleting one site while adding an unrelated one for the same
//   context in the same PR (say, a new `isNil(contextVersion)` elsewhere) also passes. Review has
//   to catch that too.
// - Official qadams are read from their package.json. `workspace:*` (every qadam today) means the
//   framework in the tree; any other spec is read for its first major number.
//
// Usage:
//   node tools/ci/check-framework-support.mjs                        # the tree, today
//   PR_BASE_SHA=<sha> node tools/ci/check-framework-support.mjs      # + checks 4a/4b against <sha> (CI)
//   node tools/ci/check-framework-support.mjs --base origin/main     # + checks 4a/4b against a ref
//   node tools/ci/check-framework-support.mjs --root <dir> --now 2027-01-01   # fixture tests
//
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const LABEL = '[check-framework-support]'
const ADR = 'adr/0002-two-framework-majors-supported-for-at-least-12-months.md'
const TABLE_PATH = 'packages/qadams/framework/src/lib/context/framework-support-table.json'
const VERSIONING_PATH = 'packages/qadams/framework/src/lib/context/versioning.ts'
const FRAMEWORK_PACKAGE_PATH = 'packages/qadams/framework/package.json'
const FRAMEWORK_PACKAGE_NAME = '@aiqadam/qadams-framework'
const DISPATCHER = 'makeActionContextBackwardCompatible'
const ENGINE_ROOT = 'packages/server/engine/src'
const SHIM_ROOTS = ['packages/qadams/framework/src', ENGINE_ROOT]
const OFFICIAL_QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const NO_CONTEXT = 'none'
const SUPPORT_MONTHS = 12
const DAY_MS = 24 * 60 * 60 * 1000

const main = () => {
  const options = parseArgs({ argv: process.argv.slice(2) })
  if (options.error) {
    fail({ problems: [options.error] })
    return
  }
  const root = options.root ?? REPO_ROOT
  const now = options.now ?? new Date()
  // `|| null`, not `?? null`: outside pull_request the workflow passes an empty PR_BASE_SHA.
  const base = options.base ?? (process.env.PR_BASE_SHA || null)

  const code = readCode({ root })
  if (code.problems.length > 0) {
    fail({ problems: code.problems })
    return
  }
  const { currentMajor, pendingMajor, frameworkVersion, enumValues, latest, dispatcher } = code
  // The major whose release has happened. A `X.0.0-<pre>` in the tree is a major on its way, and
  // must not start its predecessor's 12-month window: ADR-0002 counts released majors.
  const releasedMajor = pendingMajor ? currentMajor - 1 : currentMajor

  const table = readTable({ root, enumValues })
  if (table.problems.length > 0) {
    fail({ problems: table.problems })
    return
  }
  const rows = table.rows

  const tableProblems = checkTableAgainstCode({ rows, currentMajor, pendingMajor, frameworkVersion, latest })
  if (tableProblems.length > 0) {
    fail({ problems: tableProblems })
    return
  }

  const resolvedBase = base === null ? null : resolveCommit({ root, ref: base })
  if (base !== null && resolvedBase === null) {
    fail({ problems: [`cannot resolve the PR base ${base} — a shallow checkout (needs fetch-depth: 0) or an unreachable SHA. Refusing to report "no shim removed" without having compared.`] })
    return
  }

  const support = rows.map((row) => ({ row, ...supportOf({ row, releasedMajor, now }) }))
  const requiredShims = support
    .filter((entry) => entry.supported)
    .flatMap((entry) => entry.row.contextVersions
      .filter((context) => context !== latest)
      .map((context) => ({ context, entry })))

  const qadams = readOfficialQadams({ root, currentMajor })
  const skipped = { problems: [], note: 'skipped (no PR_BASE_SHA / --base)' }
  const history = resolvedBase === null ? skipped : checkTableHistory({ root, base, resolvedBase, rows, now })
  const removal = resolvedBase === null ? skipped : checkRemovedShims({ root, base, resolvedBase, requiredShims, latest, enumValues })

  const problems = [
    ...history.problems,
    ...checkDispatcher({ root, dispatcher, requiredShims }),
    ...removal.problems,
    ...qadams.problems,
    ...checkOfficialQadams({ qadams: qadams.qadams, rows, dispatcher, latest }),
  ]
  if (problems.length > 0) {
    fail({ problems })
    return
  }

  console.log(`${LABEL} OK — ${FRAMEWORK_PACKAGE_NAME}@${frameworkVersion}${pendingMajor ? ` (a prerelease of ${currentMajor}.0.0)` : ''}, LATEST_CONTEXT_VERSION ${latest}, as of ${isoDate(now)}:`)
  for (const entry of support) {
    console.log(`  ${majorLabel(entry.row.major)} (contexts ${entry.row.contextVersions.join(', ')}): ${entry.supported ? 'supported' : 'retirable'} — ${entry.reason}`)
  }
  console.log(`  dispatcher handles: ${[...dispatcher.contexts].join(', ') || '(nothing)'}; required shims: ${unique(requiredShims.map((shim) => shim.context)).join(', ') || '(none)'}`)
  console.log(`  table history against base: ${base === null ? history.note : `${base} — ${history.note}`}`)
  console.log(`  removal check against base: ${base === null ? removal.note : `${base} — ${removal.note}`}`)
  console.log(`  official qadams: ${qadams.qadams.length}, all on a framework major the engine supports`)
}

const fail = ({ problems }) => {
  console.error(`${LABEL} ${problems.length} problem(s):\n`)
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error(`\nThe framework support table (${TABLE_PATH}) and the rule it enforces are ADR-0002 (${ADR}).`)
  process.exitCode = 1
}

const parseArgs = ({ argv }) => {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--root' && value) {
      options.root = path.resolve(value)
      i++
    }
    else if (arg === '--base' && value) {
      options.base = value
      i++
    }
    else if (arg === '--now' && value) {
      const now = new Date(value)
      if (Number.isNaN(now.getTime())) {
        return { error: `--now ${value} is not a date` }
      }
      options.now = now
      i++
    }
    else {
      return { error: `unknown or incomplete argument: ${arg}` }
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// The code side: framework version, ContextVersion, LATEST_CONTEXT_VERSION, the dispatcher
// ---------------------------------------------------------------------------

const readCode = ({ root }) => {
  const packageText = readOptional({ file: path.join(root, FRAMEWORK_PACKAGE_PATH) })
  const versioningText = readOptional({ file: path.join(root, VERSIONING_PATH) })
  if (packageText === null || versioningText === null) {
    return { problems: [`cannot read ${packageText === null ? FRAMEWORK_PACKAGE_PATH : VERSIONING_PATH} under ${root} — is --root correct, or did the framework move? The gate refuses to pass without it.`] }
  }
  const frameworkPackage = parseJson({ text: packageText })
  const frameworkVersion = frameworkPackage?.version
  const parsedVersion = parseVersion({ version: frameworkVersion })
  const currentMajor = parsedVersion?.major ?? null
  if (currentMajor === null) {
    return { problems: [`${FRAMEWORK_PACKAGE_PATH} has no readable semver "version" (got ${JSON.stringify(frameworkVersion)})`] }
  }

  const sourceFile = ts.createSourceFile(VERSIONING_PATH, versioningText, ts.ScriptTarget.Latest, true)
  const enumValues = readContextVersionEnum({ sourceFile })
  if (enumValues === null) {
    return { problems: [`${VERSIONING_PATH} declares no \`enum ContextVersion\` with string members`] }
  }
  const latest = readLatestContextVersion({ sourceFile, enumValues })
  if (latest === null) {
    return { problems: [`${VERSIONING_PATH} has no \`LATEST_CONTEXT_VERSION = ContextVersion.<member>\``] }
  }
  const dispatcherSites = collectShimSites({ sourceFile, file: VERSIONING_PATH, enumValues }).filter((site) => site.fn === DISPATCHER)
  const dispatcher = {
    found: dispatcherSites.length > 0,
    contexts: new Set(dispatcherSites.flatMap((site) => site.contexts)),
  }
  // `2.0.0-rc.1` is major 2 on its way; `1.3.0-next.0` is a prerelease inside a released major 1.
  const pendingMajor = parsedVersion.prerelease && parsedVersion.minor === 0 && parsedVersion.patch === 0 && currentMajor >= 1
  return { problems: [], currentMajor, pendingMajor, frameworkVersion, enumValues, latest, dispatcher }
}

const readContextVersionEnum = ({ sourceFile }) => {
  const declaration = sourceFile.statements.find((statement) => ts.isEnumDeclaration(statement) && statement.name.text === 'ContextVersion')
  if (!declaration) {
    return null
  }
  const entries = declaration.members
    .filter((member) => ts.isIdentifier(member.name) && member.initializer && ts.isStringLiteralLike(member.initializer))
    .map((member) => [member.name.text, member.initializer.text])
  return entries.length === 0 ? null : new Map(entries)
}

const readLatestContextVersion = ({ sourceFile, enumValues }) => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'LATEST_CONTEXT_VERSION' && declaration.initializer) {
        return contextOfExpression({ node: declaration.initializer, enumValues })
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const readTable = ({ root, enumValues }) => {
  const text = readOptional({ file: path.join(root, TABLE_PATH) })
  if (text === null) {
    return { problems: [`the support table ${TABLE_PATH} is missing`] }
  }
  const parsed = parseJson({ text })
  if (parsed === null || !Array.isArray(parsed.majors) || parsed.majors.length === 0) {
    return { problems: [`${TABLE_PATH} is not valid JSON with a non-empty "majors" array`] }
  }
  const knownContexts = new Set([NO_CONTEXT, ...enumValues.values()])
  const problems = parsed.majors.flatMap((row, index) => validateRow({ row, index, knownContexts }))
  return { problems, rows: parsed.majors }
}

const validateRow = ({ row, index, knownContexts }) => {
  const where = `${TABLE_PATH} majors[${index}]`
  if (row === null || typeof row !== 'object') {
    return [`${where} is not an object`]
  }
  const problems = []
  if (!Number.isInteger(row.major) || row.major < 0) {
    problems.push(`${where}.major must be a non-negative integer (got ${JSON.stringify(row.major)})`)
  }
  const contexts = row.contextVersions
  if (!Array.isArray(contexts) || contexts.length === 0) {
    problems.push(`${where}.contextVersions must be a non-empty array`)
  }
  else {
    const unknown = contexts.filter((context) => !knownContexts.has(context))
    if (unknown.length > 0) {
      problems.push(`${where}.contextVersions has ${JSON.stringify(unknown)}, which is neither a ContextVersion value in ${VERSIONING_PATH} nor "${NO_CONTEXT}"`)
    }
    if (new Set(contexts).size !== contexts.length) {
      problems.push(`${where}.contextVersions lists a context version twice`)
    }
    if (Number.isInteger(row.major) && row.major >= 1 && contexts.length !== 1) {
      problems.push(`${where}: framework major ${row.major} must have exactly one context version — a new context version is a new framework major (ADR-0001, ADR-0002); only the 0.x row carries several`)
    }
  }
  if (row.released !== null && parseDate({ value: row.released }) === null) {
    problems.push(`${where}.released must be a YYYY-MM-DD date (got ${JSON.stringify(row.released)})`)
  }
  if (row.successorReleased !== null && parseDate({ value: row.successorReleased }) === null) {
    problems.push(`${where}.successorReleased must be a YYYY-MM-DD date or null (got ${JSON.stringify(row.successorReleased)})`)
  }
  return problems
}

const checkTableAgainstCode = ({ rows, currentMajor, pendingMajor, frameworkVersion, latest }) => {
  const problems = []
  rows.forEach((row, index) => {
    const isPendingRow = pendingMajor && row.major === currentMajor
    if (row.released === null && row.major !== 0 && !isPendingRow) {
      problems.push(`${TABLE_PATH}: ${majorLabel(row.major)}.released is null; only the 0.x row, and the row of a major that is still a prerelease in ${FRAMEWORK_PACKAGE_PATH}, may omit it`)
    }
    if (isPendingRow && row.released !== null) {
      problems.push(`${TABLE_PATH}: ${majorLabel(row.major)}.released is ${row.released}, but ${FRAMEWORK_PACKAGE_PATH} is the prerelease ${frameworkVersion}. Keep released (and ${majorLabel(row.major - 1)}.successorReleased) null until ${row.major}.0.0 itself is released: a prerelease does not start ${majorLabel(row.major - 1)}'s 12-month window.`)
    }
    if (row.major !== index) {
      problems.push(`${TABLE_PATH}: rows must run 0, 1, 2, … with no gaps; row ${index} is major ${row.major}`)
    }
    const next = rows[index + 1]
    if (next === undefined) {
      if (row.successorReleased !== null) {
        problems.push(`${TABLE_PATH}: ${majorLabel(row.major)} is the last row, so its successorReleased must be null until ${row.major + 1}.0.0 has a row (got ${row.successorReleased})`)
      }
    }
    else if (row.successorReleased !== next.released) {
      problems.push(`${TABLE_PATH}: ${majorLabel(row.major)}.successorReleased (${row.successorReleased}) must equal ${majorLabel(next.major)}.released (${next.released})`)
    }
    if (row.released !== null && row.successorReleased !== null && row.successorReleased < row.released) {
      problems.push(`${TABLE_PATH}: ${majorLabel(row.major)} was succeeded (${row.successorReleased}) before it was released (${row.released})`)
    }
  })
  const lastMajor = rows[rows.length - 1].major
  const currentRow = rows.find((row) => row.major === currentMajor)
  if (currentMajor > lastMajor) {
    const previous = rows[rows.length - 1]
    problems.push(pendingMajor
      ? `framework major ${currentMajor} (the prerelease ${FRAMEWORK_PACKAGE_NAME}@${frameworkVersion} in ${FRAMEWORK_PACKAGE_PATH}) has no row in ${TABLE_PATH}. Add { "major": ${currentMajor}, "contextVersions": ["${latest}"], "released": null, "successorReleased": null }; its date and ${majorLabel(previous.major)}.successorReleased are filled in when ${currentMajor}.0.0 itself is released.`
      : `framework major ${currentMajor} (${FRAMEWORK_PACKAGE_NAME}@${frameworkVersion} in ${FRAMEWORK_PACKAGE_PATH}) is released without a row in ${TABLE_PATH}. Add { "major": ${currentMajor}, "contextVersions": ["${latest}"], "released": "<YYYY-MM-DD of this release>", "successorReleased": null }, and set ${majorLabel(previous.major)}.successorReleased to the same date.`)
  }
  else if (currentMajor < lastMajor) {
    problems.push(`${TABLE_PATH} has a row for framework major ${lastMajor}, but ${FRAMEWORK_PACKAGE_PATH} is ${frameworkVersion}: a row is added with the release that makes it the current major, not before.`)
  }
  else if (currentRow !== undefined && !currentRow.contextVersions.includes(latest)) {
    problems.push(`LATEST_CONTEXT_VERSION is ${latest} (${VERSIONING_PATH}), but the row for the current framework major ${majorLabel(currentMajor)} lists ${JSON.stringify(currentRow.contextVersions)}. A new context version is a new framework major (ADR-0001, ADR-0002): release it as ${currentMajor + 1}.0.0 with its own row.`)
  }
  return problems
}

// A major is supported while it is the current or the previous released one, and — once two later
// majors are released — until 12 months after its successor's release. Rows are contiguous and
// every row up to the released major has its date (checked above), so a row behind it has a
// successor date.
const supportOf = ({ row, releasedMajor, now }) => {
  if (row.major > releasedMajor) {
    return { supported: true, reason: 'not released yet (a prerelease in the tree)' }
  }
  if (row.major === releasedMajor) {
    return { supported: true, reason: 'the current major' }
  }
  if (row.major === releasedMajor - 1) {
    const until = addMonths({ date: parseDate({ value: row.successorReleased }), months: SUPPORT_MONTHS })
    return { supported: true, reason: `the previous major; retirable no earlier than ${isoDate(until)} and only once ${row.major + 2}.0.0 is released` }
  }
  const until = addMonths({ date: parseDate({ value: row.successorReleased }), months: SUPPORT_MONTHS })
  if (now.getTime() < until.getTime()) {
    return { supported: true, reason: `${row.major + 1}.0.0 was released ${row.successorReleased}; supported until ${isoDate(until)}` }
  }
  return { supported: false, reason: `${row.major + 1}.0.0 was released ${row.successorReleased} (12 months passed on ${isoDate(until)}) and ${row.major + 2}.0.0 is out; its shims may be removed, as a platform major with a breaking-changes.mdx entry` }
}

// ---------------------------------------------------------------------------
// Checks 3 and 4: shims
// ---------------------------------------------------------------------------

const checkDispatcher = ({ root, dispatcher, requiredShims }) => {
  if (requiredShims.length === 0) {
    return []
  }
  if (!dispatcher.found) {
    return [`${VERSIONING_PATH} has no \`${DISPATCHER}\` switching on ContextVersion, but supported majors still need shims for ${unique(requiredShims.map((shim) => shim.context)).join(', ')}`]
  }
  const missing = requiredShims.filter((shim) => !dispatcher.contexts.has(shim.context))
  const problems = missing.map((shim) => `context shim "${shim.context}" is missing from \`${DISPATCHER}\` (${VERSIONING_PATH}) while ${majorLabel(shim.entry.row.major)} still needs it — ${shim.entry.reason}`)
  const engineFiles = listTsFiles({ dir: path.join(root, ENGINE_ROOT) })
  const engineCallsDispatcher = engineFiles.some((file) => callsDispatcher({ file }))
  if (!engineCallsDispatcher) {
    problems.push(`nothing under ${ENGINE_ROOT} calls \`${DISPATCHER}\` any more, so the engine applies none of the context shims supported majors still need (${unique(requiredShims.map((shim) => shim.context)).join(', ')})`)
  }
  return problems
}

// A call, not a mention: a comment or an import of the name does not apply any shim.
const callsDispatcher = ({ file }) => {
  const text = fs.readFileSync(file, 'utf-8')
  if (!text.includes(DISPATCHER)) {
    return false
  }
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (node) => (ts.isCallExpression(node) && calleeName({ node: node.expression }) === DISPATCHER) || (ts.forEachChild(node, visit) ?? false)
  return visit(sourceFile)
}

const calleeName = ({ node }) => {
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return null
}

// ---------------------------------------------------------------------------
// The table's history: what a PR may change in rows that are already on the base
// ---------------------------------------------------------------------------

// The table decides which shims are owed, so a PR that edits it could otherwise owe itself
// nothing: narrow a row's contextVersions, or backdate a release, and delete the shim in the same
// diff. Once merged, a row's major, contextVersions and dates are history. A PR may only append
// rows and fill in a date that was null (the successor date of the last row, or the release date
// of a major leaving prerelease), and a date it fills in must lie between its base commit and
// today.
const checkTableHistory = ({ root, base, resolvedBase, rows, now }) => {
  const listed = gitTry({ root, args: ['ls-tree', '--name-only', resolvedBase, '--', TABLE_PATH] })
  if (listed === null) {
    return { problems: [`\`git ls-tree\` failed at ${base} — refusing to skip the table-history check.`] }
  }
  if (listed.trim() === '') {
    return { problems: [], note: 'no table at base (it is introduced here)' }
  }
  const baseParsed = parseJson({ text: gitTry({ root, args: ['show', `${resolvedBase}:${TABLE_PATH}`] }) ?? '' })
  const committed = gitTry({ root, args: ['show', '-s', '--format=%cI', resolvedBase] })
  const baseDate = committed === null ? null : new Date(committed.trim())
  if (baseParsed === null || !Array.isArray(baseParsed.majors) || baseDate === null || Number.isNaN(baseDate.getTime())) {
    return { problems: [`cannot read ${TABLE_PATH} or the commit date at ${base} — refusing to skip the table-history check.`] }
  }
  // One day of slack each way: the date in the table is a calendar date written in someone's
  // time zone, the commit date is an instant.
  const earliest = isoDate(new Date(baseDate.getTime() - DAY_MS))
  const latestAllowed = isoDate(new Date(now.getTime() + DAY_MS))
  const checkNewDate = ({ label, value }) => {
    if (value === null || (value >= earliest && value <= latestAllowed)) {
      return []
    }
    return [value < earliest
      ? `${TABLE_PATH}: ${label} is set to ${value} in this change, before its base (${isoDate(baseDate)}). A release date is the day the release happens; it cannot predate the change that records it.`
      : `${TABLE_PATH}: ${label} is set to ${value}, which is after today (${isoDate(now)}). Record a release date once the release has happened.`]
  }
  const baseMajors = new Set(baseParsed.majors.map((row) => row?.major))
  const problems = baseParsed.majors.flatMap((baseRow) => {
    const label = majorLabel(baseRow?.major)
    const row = rows.find((candidate) => candidate.major === baseRow?.major)
    if (row === undefined) {
      return [`${TABLE_PATH}: the row for ${label} was deleted. Rows are history; a retired major keeps its row.`]
    }
    const rowProblems = []
    if (JSON.stringify(row.contextVersions) !== JSON.stringify(baseRow.contextVersions)) {
      rowProblems.push(`${TABLE_PATH}: ${label}.contextVersions changed from ${JSON.stringify(baseRow.contextVersions)} to ${JSON.stringify(row.contextVersions)}. What a major's qadams report is fixed once its row is merged; changing it would change which shims the gate requires.`)
    }
    for (const field of ['released', 'successorReleased']) {
      if (baseRow[field] !== null && row[field] !== baseRow[field]) {
        rowProblems.push(`${TABLE_PATH}: ${label}.${field} changed from ${baseRow[field]} to ${row[field]}. A recorded release date is history; moving it moves the 12-month window.`)
      }
      else if (baseRow[field] === null) {
        rowProblems.push(...checkNewDate({ label: `${label}.${field}`, value: row[field] }))
      }
    }
    return rowProblems
  })
  const appended = rows.filter((row) => !baseMajors.has(row.major))
  const appendedProblems = appended.flatMap((row) => checkNewDate({ label: `${majorLabel(row.major)}.released`, value: row.released }))
  return {
    problems: [...problems, ...appendedProblems],
    note: `${baseParsed.majors.length} row(s) at base unchanged except for dates filled in${appended.length > 0 ? `, ${appended.length} appended` : ''}`,
  }
}

const checkRemovedShims = ({ root, base, resolvedBase, requiredShims, latest, enumValues }) => {
  const baseVersioning = gitTry({ root, args: ['show', `${resolvedBase}:${VERSIONING_PATH}`] })
  const baseEnum = baseVersioning === null ? null : readContextVersionEnum({ sourceFile: ts.createSourceFile(VERSIONING_PATH, baseVersioning, ts.ScriptTarget.Latest, true) })
  const baseFiles = listBaseShimFiles({ root, base: resolvedBase })
  if (baseFiles === null) {
    return { problems: [`\`git grep\` over ${base} failed — refusing to report "no shim removed" without having compared.`] }
  }
  const baseTexts = baseFiles.map((file) => ({ file, text: gitTry({ root, args: ['show', `${resolvedBase}:${file}`] }) }))
  const unreadable = baseTexts.filter((entry) => entry.text === null).map((entry) => entry.file)
  if (unreadable.length > 0) {
    return { problems: [`\`git show\` failed at ${base} for ${unreadable.join(', ')} — refusing to report "no shim removed" without having compared.`] }
  }
  const baseSites = baseTexts.flatMap(({ file, text }) => collectShimSites({ sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file, enumValues: baseEnum ?? enumValues }))
  const headSites = SHIM_ROOTS
    .flatMap((dir) => listTsFiles({ dir: path.join(root, dir) }))
    .flatMap((file) => {
      const text = fs.readFileSync(file, 'utf-8')
      const relative = path.relative(root, file).split(path.sep).join('/')
      return mentionsContextVersion({ text }) ? collectShimSites({ sourceFile: ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true), file: relative, enumValues }) : []
    })

  const baseCounts = countContexts({ sites: baseSites })
  const headCounts = countContexts({ sites: headSites })
  const needed = new Map(requiredShims.map((shim) => [shim.context, shim.entry]))
  const problems = [...baseCounts.entries()]
    .filter(([context, count]) => context !== latest && needed.has(context) && (headCounts.get(context) ?? 0) < count)
    .map(([context, count]) => {
      const entry = needed.get(context)
      const headKeys = new Set(headSites.filter((site) => site.contexts.includes(context)).map(siteKey))
      const gone = baseSites.filter((site) => site.contexts.includes(context) && !headKeys.has(siteKey(site))).map(siteKey)
      const where = gone.length > 0 ? ` (no longer in ${unique(gone).join(', ')})` : ''
      return `a context shim for "${context}" was removed: ${count} shim site(s) handled it at ${base}, ${headCounts.get(context) ?? 0} now${where}. ${majorLabel(entry.row.major)} still needs it — ${entry.reason}`
    })
  return { problems, note: `${baseSites.length} shim site(s) at base, ${headSites.length} now` }
}

const listBaseShimFiles = ({ root, base }) => {
  // `git grep` exits 1 when nothing matches, which is a real answer here, not an error.
  try {
    const out = execFileSync('git', ['-C', root, 'grep', '-l', '-e', 'ContextVersion', '-e', 'contextVersion', base, '--', ...SHIM_ROOTS], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.split('\n').filter(Boolean).map((line) => line.slice(base.length + 1)).filter(isShimSource)
  }
  catch (error) {
    return error.status === 1 ? [] : null
  }
}

// One entry per branch: a `switch` over a context version contributes one site whose contexts are
// its case labels; an equality test contributes one site with one context.
const collectShimSites = ({ sourceFile, file, enumValues }) => {
  const sites = []
  const visit = (node) => {
    if (ts.isSwitchStatement(node)) {
      const labels = node.caseBlock.clauses.filter(ts.isCaseClause).map((clause) => clause.expression)
      const onContext = labels.some((label) => isContextVersionMember({ node: label })) || namesContextVersion({ node: node.expression })
      if (onContext) {
        const contexts = labels.map((label) => contextOfExpression({ node: label, enumValues })).filter((context) => context !== null)
        if (contexts.length > 0) {
          sites.push({ file, fn: enclosingName({ node }), line: lineOf({ node, sourceFile }), contexts: unique(contexts) })
        }
      }
    }
    else if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const context = contextOfComparison({ left: node.left, right: node.right, enumValues })
      if (context !== null) {
        sites.push({ file, fn: enclosingName({ node }), line: lineOf({ node, sourceFile }), contexts: [context] })
      }
    }
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'isNil' && node.arguments.length === 1 && namesContextVersion({ node: node.arguments[0] })) {
      sites.push({ file, fn: enclosingName({ node }), line: lineOf({ node, sourceFile }), contexts: [NO_CONTEXT] })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

const contextOfComparison = ({ left, right, enumValues }) => {
  for (const [value, other] of [[left, right], [right, left]]) {
    if (isContextVersionMember({ node: value })) {
      return contextOfExpression({ node: value, enumValues })
    }
    if (isUndefined({ node: value }) && namesContextVersion({ node: other })) {
      return NO_CONTEXT
    }
  }
  return null
}

const contextOfExpression = ({ node, enumValues }) => {
  if (isUndefined({ node })) {
    return NO_CONTEXT
  }
  if (isContextVersionMember({ node })) {
    return enumValues.get(node.name.text) ?? `ContextVersion.${node.name.text}`
  }
  return null
}

const isContextVersionMember = ({ node }) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ContextVersion'

const isUndefined = ({ node }) => (ts.isIdentifier(node) && node.text === 'undefined') || ts.isVoidExpression(node)

const namesContextVersion = ({ node }) => /contextversion/i.test(node.getText())

const mentionsContextVersion = ({ text }) => /contextversion/i.test(text)

const enclosingName = ({ node }) => {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText()
    }
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current)) && current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
      return current.name.getText()
    }
  }
  return '<top level>'
}

const lineOf = ({ node, sourceFile }) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

const siteKey = (site) => `${site.file} ${site.fn}`

const countContexts = ({ sites }) => sites
  .flatMap((site) => site.contexts)
  .reduce((counts, context) => new Map([...counts, [context, (counts.get(context) ?? 0) + 1]]), new Map())

// ---------------------------------------------------------------------------
// Check 5: official qadams
// ---------------------------------------------------------------------------

const readOfficialQadams = ({ root, currentMajor }) => {
  const manifests = OFFICIAL_QADAM_ROOTS.flatMap((dir) => {
    const absolute = path.join(root, dir)
    if (!fs.existsSync(absolute)) {
      return []
    }
    return fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/package.json`)
      .filter((file) => fs.existsSync(path.join(root, file)))
  })
  if (manifests.length === 0) {
    return { qadams: [], problems: [`found no official qadam package.json under ${OFFICIAL_QADAM_ROOTS.join(', ')} (root: ${root}) — refusing to report that every official qadam is supported after checking none`] }
  }
  const results = manifests.map((file) => {
    const manifest = parseJson({ text: fs.readFileSync(path.join(root, file), 'utf-8') })
    if (manifest === null) {
      return { problem: `${file} is not valid JSON` }
    }
    const spec = DEP_SECTIONS.map((section) => manifest[section]?.[FRAMEWORK_PACKAGE_NAME]).find((value) => typeof value === 'string')
    if (spec === undefined) {
      return { qadam: null }
    }
    const major = spec.startsWith('workspace:') ? currentMajor : specMajor({ spec })
    if (major === null) {
      return { problem: `${file} depends on ${FRAMEWORK_PACKAGE_NAME}@${spec}, which names no framework major this gate can read` }
    }
    return { qadam: { file, name: manifest.name ?? file, spec, major } }
  })
  return {
    qadams: results.map((result) => result.qadam).filter(Boolean),
    problems: results.map((result) => result.problem).filter(Boolean),
  }
}

// "Supported by the engine", not "inside the window": a qadam on a major whose window has passed
// but whose shims are still in the engine runs fine, and asking the calendar here would let the
// passage of time fail a tree that passed yesterday.
const checkOfficialQadams = ({ qadams, rows, dispatcher, latest }) => unique(qadams.map((qadam) => qadam.major))
  .sort((a, b) => a - b)
  .flatMap((major) => {
    const affected = qadams.filter((qadam) => qadam.major === major)
    const names = describeQadams({ qadams: affected })
    const row = rows.find((candidate) => candidate.major === major)
    if (row === undefined) {
      return [`${affected.length} official qadam(s) are built against framework major ${major}, which has no row in ${TABLE_PATH}: ${names}`]
    }
    const dropped = row.contextVersions.filter((context) => context !== latest && !dispatcher.contexts.has(context))
    if (dropped.length === 0) {
      return []
    }
    return [`${affected.length} official qadam(s) are built against framework major ${majorLabel(major)}, which the engine no longer supports (no shim for ${dropped.join(', ')} in \`${DISPATCHER}\`): ${names}`]
  })

const describeQadams = ({ qadams }) => {
  const shown = qadams.slice(0, 5).map((qadam) => `${qadam.name} (${FRAMEWORK_PACKAGE_NAME}@${qadam.spec}, ${qadam.file})`)
  return qadams.length > shown.length ? `${shown.join(', ')} and ${qadams.length - shown.length} more` : shown.join(', ')
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const listTsFiles = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      return []
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return listTsFiles({ dir: full })
    }
    return entry.isFile() && isShimSource(full) ? [full] : []
  })
}

const isShimSource = (file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')

const resolveCommit = ({ root, ref }) => {
  const resolved = gitTry({ root, args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`] })?.trim()
  return resolved ? resolved : null
}

const gitTry = ({ root, args }) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  catch {
    return null
  }
}

const readOptional = ({ file }) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null)

const parseJson = ({ text }) => {
  try {
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

const parseVersion = ({ version }) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(\+.*)?$/.exec(String(version ?? ''))
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] !== undefined } : null
}

// The first number of a dependency spec: `1.2.3`, `^1.2.3`, `~1.2`, `>=1.0.0 <2` all start at 1.
const specMajor = ({ spec }) => {
  const match = /^[^\d]*(\d+)/.exec(spec)
  return match ? Number(match[1]) : null
}

const parseDate = ({ value }) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return isoDate(date) === value ? date : null
}

// Date.UTC normalises an overflowing day, so 12 months after 2028-02-29 is 2029-03-01 — a day
// later than a strict reading, which errs towards keeping a shim.
const addMonths = ({ date, months }) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()))

const isoDate = (date) => date.toISOString().slice(0, 10)

const majorLabel = (major) => (major === 0 ? '0.x' : `${major}.x`)

const unique = (values) => [...new Set(values)]

main()
