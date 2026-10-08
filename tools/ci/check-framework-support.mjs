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
// major, and for at least 12 months after its successor was released. This gate fails when:
//
//   1. the table is malformed or disagrees with the code — a gap in the majors, a successor date
//      that is not the next row's release date, or LATEST_CONTEXT_VERSION missing from the current
//      major's row (a new context version is a new framework major);
//   2. the framework major in packages/qadams/framework/package.json has no row ("a framework
//      major is released without a row");
//   3. a context shim a supported major needs is missing from the dispatcher — checked on the
//      tree, so it holds on every run, not only on pull requests;
//   4. a context shim was removed anywhere in the framework or the engine while a supported major
//      needs it — checked against the PR base (PR_BASE_SHA or --base), because a deleted branch
//      cannot be seen on the tree alone;
//   5. an official qadam (packages/qadams/{core,community}) is built against a framework major the
//      engine no longer supports: a major with no row, or one whose shims the engine has dropped.
//
// ---------------------------------------------------------------------------
// DETERMINISTIC AND MONOTONIC
// ---------------------------------------------------------------------------
// No network, no registry, no stored data: the inputs are the tree, the PR base and today's date
// (UTC; `--now` pins it for the fixture tests). Time enters in one place only — whether a major is
// still inside its 12-month window — and there it can only shrink the set of supported majors.
// So the passage of time can only allow a removal (checks 3 and 4); it never makes code that
// passed fail. Checks 1, 2 and 5 do not read the date at all; check 5 asks what the engine still
// handles, not what the calendar allows, for exactly that reason.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVABLY CANNOT DO
// ---------------------------------------------------------------------------
// - It recognises a shim by its shape: a `case ContextVersion.X:` / `case undefined:` in a
//   `switch` that branches on a context version, or an equality test against `ContextVersion.X`,
//   `undefined` or `isNil(...)` on something named like `contextVersion`, in
//   packages/qadams/framework/src and packages/server/engine/src. A shim kept by name but emptied
//   (its branch now does what the default does) is not detected; review has to catch that.
// - Check 4 compares how many shim branches each context version has before and after the PR, so
//   moving a branch to another file or function passes, and merging two branches into one fails.
//   The second is deliberate: a gate that blocks shim removal errs towards keeping a branch.
// - "Released" means the major in packages/qadams/framework/package.json, because that is what
//   the official qadams in the tree are built against and publish with. A prerelease of a new
//   major (`2.0.0-rc.1`) counts as that major and needs its row.
// - Official qadams are read from their package.json. `workspace:*` (every qadam today) means the
//   framework in the tree; any other spec is read for its first major number.
//
// Usage:
//   node tools/ci/check-framework-support.mjs                        # the tree, today
//   PR_BASE_SHA=<sha> node tools/ci/check-framework-support.mjs      # + removals since <sha> (CI)
//   node tools/ci/check-framework-support.mjs --base origin/main     # + removals since a ref
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
  const { currentMajor, frameworkVersion, enumValues, latest, dispatcher } = code

  const table = readTable({ root, enumValues })
  if (table.problems.length > 0) {
    fail({ problems: table.problems })
    return
  }
  const rows = table.rows

  const tableProblems = checkTableAgainstCode({ rows, currentMajor, frameworkVersion, latest })
  if (tableProblems.length > 0) {
    fail({ problems: tableProblems })
    return
  }

  const support = rows.map((row) => ({ row, ...supportOf({ row, currentMajor, now }) }))
  const requiredShims = support
    .filter((entry) => entry.supported)
    .flatMap((entry) => entry.row.contextVersions
      .filter((context) => context !== latest)
      .map((context) => ({ context, entry })))

  const qadams = readOfficialQadams({ root, currentMajor })
  const removal = base === null ? { problems: [], note: 'skipped (no PR_BASE_SHA / --base)' } : checkRemovedShims({ root, base, requiredShims, latest, enumValues })

  const problems = [
    ...checkDispatcher({ root, dispatcher, requiredShims }),
    ...removal.problems,
    ...qadams.problems,
    ...checkOfficialQadams({ qadams: qadams.qadams, rows, dispatcher, latest }),
  ]
  if (problems.length > 0) {
    fail({ problems })
    return
  }

  console.log(`${LABEL} OK — ${FRAMEWORK_PACKAGE_NAME}@${frameworkVersion}, LATEST_CONTEXT_VERSION ${latest}, as of ${isoDate(now)}:`)
  for (const entry of support) {
    console.log(`  ${majorLabel(entry.row.major)} (contexts ${entry.row.contextVersions.join(', ')}): ${entry.supported ? 'supported' : 'retirable'} — ${entry.reason}`)
  }
  console.log(`  dispatcher handles: ${[...dispatcher.contexts].join(', ') || '(nothing)'}; required shims: ${unique(requiredShims.map((shim) => shim.context)).join(', ') || '(none)'}`)
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
  const currentMajor = versionMajor({ version: frameworkVersion })
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
  return { problems: [], currentMajor, frameworkVersion, enumValues, latest, dispatcher }
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
  if (row.released === null) {
    if (row.major !== 0) {
      problems.push(`${where}.released is null; only the 0.x row may omit its release date`)
    }
  }
  else if (parseDate({ value: row.released }) === null) {
    problems.push(`${where}.released must be a YYYY-MM-DD date (got ${JSON.stringify(row.released)})`)
  }
  if (row.successorReleased !== null && parseDate({ value: row.successorReleased }) === null) {
    problems.push(`${where}.successorReleased must be a YYYY-MM-DD date or null (got ${JSON.stringify(row.successorReleased)})`)
  }
  return problems
}

const checkTableAgainstCode = ({ rows, currentMajor, frameworkVersion, latest }) => {
  const problems = []
  rows.forEach((row, index) => {
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
    problems.push(`framework major ${currentMajor} (${FRAMEWORK_PACKAGE_NAME}@${frameworkVersion} in ${FRAMEWORK_PACKAGE_PATH}) is released without a row in ${TABLE_PATH}. Add { "major": ${currentMajor}, "contextVersions": ["${latest}"], "released": "<YYYY-MM-DD of this release>", "successorReleased": null }, and set ${majorLabel(previous.major)}.successorReleased to the same date.`)
  }
  else if (currentMajor < lastMajor) {
    problems.push(`${TABLE_PATH} has a row for framework major ${lastMajor}, but ${FRAMEWORK_PACKAGE_PATH} is ${frameworkVersion}: a row is added with the release that makes it the current major, not before.`)
  }
  else if (currentRow !== undefined && !currentRow.contextVersions.includes(latest)) {
    problems.push(`LATEST_CONTEXT_VERSION is ${latest} (${VERSIONING_PATH}), but the row for the current framework major ${majorLabel(currentMajor)} lists ${JSON.stringify(currentRow.contextVersions)}. A new context version is a new framework major (ADR-0001, ADR-0002): release it as ${currentMajor + 1}.0.0 with its own row.`)
  }
  return problems
}

// A major is supported while it is the current or the previous one, and — once two later majors
// exist — until 12 months after its successor's release. Rows are contiguous and end at the
// current major (checked above), so a row two or more behind has a successor date.
const supportOf = ({ row, currentMajor, now }) => {
  if (row.major === currentMajor) {
    return { supported: true, reason: 'the current major' }
  }
  if (row.major === currentMajor - 1) {
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
  const engineCallsDispatcher = engineFiles.some((file) => fs.readFileSync(file, 'utf-8').includes(DISPATCHER))
  if (!engineCallsDispatcher) {
    problems.push(`nothing under ${ENGINE_ROOT} calls \`${DISPATCHER}\` any more, so the engine applies none of the context shims supported majors still need (${unique(requiredShims.map((shim) => shim.context)).join(', ')})`)
  }
  return problems
}

const checkRemovedShims = ({ root, base, requiredShims, latest, enumValues }) => {
  const resolved = gitTry({ root, args: ['rev-parse', '--verify', '--quiet', `${base}^{commit}`] })?.trim() ?? null
  if (resolved === null || resolved === '') {
    return { problems: [`cannot resolve the PR base ${base} — a shallow checkout (needs fetch-depth: 0) or an unreachable SHA. Refusing to report "no shim removed" without having compared.`] }
  }
  const baseVersioning = gitTry({ root, args: ['show', `${resolved}:${VERSIONING_PATH}`] })
  const baseEnum = baseVersioning === null ? null : readContextVersionEnum({ sourceFile: ts.createSourceFile(VERSIONING_PATH, baseVersioning, ts.ScriptTarget.Latest, true) })
  const baseFiles = listBaseShimFiles({ root, base: resolved })
  if (baseFiles === null) {
    return { problems: [`\`git grep\` over ${base} failed — refusing to report "no shim removed" without having compared.`] }
  }
  const baseSites = baseFiles.flatMap((file) => {
    const text = gitTry({ root, args: ['show', `${resolved}:${file}`] })
    return text === null ? [] : collectShimSites({ sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), file, enumValues: baseEnum ?? enumValues })
  })
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
      return `a context shim for "${context}" was removed: ${count} branch(es) handled it at ${base}, ${headCounts.get(context) ?? 0} now${where}. ${majorLabel(entry.row.major)} still needs it — ${entry.reason}`
    })
  return { problems, note: `${baseSites.length} shim branch(es) at base, ${headSites.length} now` }
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

const versionMajor = ({ version }) => {
  const match = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(String(version ?? ''))
  return match ? Number(match[1]) : null
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
