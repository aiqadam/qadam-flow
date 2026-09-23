#!/usr/bin/env node
//
// Static scan for #426: every action that waits on a waitpoint must say so.
//
// `ap_validate_flow`'s `inline_pause` check has to know, before publish, which steps of an
// inline subflow will pause the run — an inline child has no queue job to resume from, so such a
// flow validates green and fails at run time. Until #426 that knowledge was a hardcoded table in
// the API (`ALWAYS_PAUSING_ACTIONS`), built once by grepping the qadams and kept true by nobody:
// the very grep that built it missed Slack's `request_action_message` / `request_action_direct_message`,
// which wait through a helper in `common/request-action.ts` rather than in their own files.
//
// The fact now lives with the action, as `pauses: true | 'conditional'` on `createAction`, and
// this scan is what keeps that declaration honest. It asserts two things over
// `packages/qadams/{community,core,common}`:
//
//   1. A file that calls `waitForWaitpoint` and defines actions declares `pauses` on every one
//      of them. A file that calls it and defines no action is a helper: every file in the same
//      qadam that imports it must declare `pauses` on its actions, and at least one must exist —
//      a waiting helper nobody imports is either dead code or a consumer this scan cannot see,
//      and both deserve a red build over a silent pass.
//   2. The inverse: an action that declares `pauses` sits in a file that either calls
//      `waitForWaitpoint` itself or imports a helper that does. A stale marker would make
//      `ap_validate_flow` refuse to publish a flow that works, which #426 names as the worse
//      failure — so it is caught here too.
//
// Creating a waitpoint is deliberately NOT a signal: `@aiqadam/qadam-approval`'s
// `create_approval_links` calls `createWaitpoint` and returns. Only `waitForWaitpoint` pauses.
//
// Like check-dropdown-defaults.mjs this is a text + AST scan over source, not a runtime import of
// built qadams — see that file's header for why the repo keeps CI checks off the build graph.
// Its limits follow from that: it looks for the literal identifier `waitForWaitpoint` (a call
// reached through a re-exported alias of the hook would be missed), it resolves only relative
// imports within one qadam, and it recognises `createAction({ ... })` with an object literal
// argument. Every pausing action in the tree today is within those limits.
//
// Usage:
//   node tools/ci/check-pause-markers.mjs
//   node tools/ci/check-pause-markers.mjs --root <dir>   # used by the fixture tests
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const QADAM_ROOTS = ['packages/qadams/community', 'packages/qadams/core', 'packages/qadams/common']
const WAIT_CALL = 'waitForWaitpoint'
const MARKER = 'pauses'

const main = () => {
  const options = parseArgs({ argv: process.argv.slice(2) })
  const root = options.root ?? REPO_ROOT

  const files = QADAM_ROOTS.flatMap((qadamRoot) => listSourceFiles({ dir: path.join(root, qadamRoot) }))

  // A gate that scanned nothing must fail loudly rather than pass every PR forever — same guard
  // as check-dropdown-defaults.mjs and check-i18n.mjs.
  if (files.length === 0) {
    console.error(`[check-pause-markers] scanned 0 files under ${QADAM_ROOTS.join(', ')} (root: ${root}) — is --root correct, or did a qadams directory move?`)
    process.exitCode = 1
    return
  }

  const scanned = new Map(files.map((file) => [file, scanFile({ file })]))
  const violations = [...scanned.entries()].flatMap(([file, info]) => checkFile({ file, info, scanned, root }))

  const waitingFiles = [...scanned.values()].filter((info) => info.waits).length
  if (violations.length === 0) {
    console.log(`[check-pause-markers] OK — scanned ${files.length} files, ${waitingFiles} call ${WAIT_CALL}, every pausing action declares \`${MARKER}\`.`)
    return
  }

  console.error(`[check-pause-markers] ${violations.length} problem(s):\n`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.message}`)
  }
  console.error(`\nAn action that calls ${WAIT_CALL} (directly or through a helper) must declare \`${MARKER}: true\` — or \`${MARKER}: 'conditional'\` when whether it waits depends on its configuration. An action that never waits must not declare it.`)
  process.exitCode = 1
}

const listSourceFiles = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      return []
    }
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles({ dir: fullPath })
    }
    if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts') && !fullPath.endsWith('.test.ts') && !fullPath.endsWith('.spec.ts')) {
      return [fullPath]
    }
    return []
  })
}

const scanFile = ({ file }) => {
  const text = fs.readFileSync(file, 'utf-8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const actions = []
  const imports = []
  let waits = false

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === WAIT_CALL) {
      waits = true
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
      imports.push(resolveRelativeImport({ from: file, specifier: node.moduleSpecifier.text }))
    }
    const action = asCreateActionCall({ node })
    if (action) {
      actions.push(readAction({ callNode: action, sourceFile }))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { waits, actions, imports: imports.filter((resolved) => resolved !== null) }
}

const asCreateActionCall = ({ node }) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'createAction') {
    return null
  }
  const [arg] = node.arguments
  return arg && ts.isObjectLiteralExpression(arg) ? node : null
}

const readAction = ({ callNode, sourceFile }) => {
  const [literal] = callNode.arguments
  const properties = literal.properties.filter((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
  const nameProperty = properties.find((property) => property.name.text === 'name')
  const name = nameProperty && ts.isStringLiteralLike(nameProperty.initializer) ? nameProperty.initializer.text : '<unknown>'
  const declaresMarker = properties.some((property) => property.name.text === MARKER)
  const { line } = sourceFile.getLineAndCharacterOfPosition(callNode.getStart(sourceFile))
  return { name, declaresMarker, line: line + 1 }
}

// `./common/request-action` may point at `request-action.ts` or `request-action/index.ts`.
const resolveRelativeImport = ({ from, specifier }) => {
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

const checkFile = ({ file, info, scanned, root }) => {
  const relative = path.relative(root, file)
  const consumers = [...scanned.entries()].filter(([, other]) => other.imports.includes(file))
  const importsWaitingHelper = info.imports.some((imported) => scanned.get(imported)?.waits && scanned.get(imported).actions.length === 0)

  if (info.waits && info.actions.length === 0) {
    // A helper: the obligation moves to whoever imports it.
    const consumingActions = consumers.flatMap(([, other]) => other.actions)
    if (consumingActions.length === 0) {
      return [{ file: relative, line: 1, message: `calls ${WAIT_CALL} but defines no action and no action file imports it — a pausing helper this scan cannot attribute to an action` }]
    }
    return []
  }

  return info.actions.flatMap((action) => {
    const shouldDeclare = info.waits || importsWaitingHelper
    if (shouldDeclare && !action.declaresMarker) {
      const via = info.waits ? 'calls' : 'imports a helper that calls'
      return [{ file: relative, line: action.line, message: `action "${action.name}" ${via} ${WAIT_CALL} but declares no \`${MARKER}\`` }]
    }
    if (!shouldDeclare && action.declaresMarker) {
      return [{ file: relative, line: action.line, message: `action "${action.name}" declares \`${MARKER}\` but nothing in its file (or the helpers it imports) calls ${WAIT_CALL} — a stale marker makes ap_validate_flow refuse a flow that works` }]
    }
    return []
  })
}

const parseArgs = ({ argv }) => {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      options.root = argv[++i]
    }
  }
  return options
}

main()
