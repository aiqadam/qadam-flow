#!/usr/bin/env node
//
// ADR-0001 gate 6: qadams do not import `@aiqadam/shared`. Qadams build against the SDK only
// (`@aiqadam/qadams-framework`, `@aiqadam/qadams-common`); `shared` is the server/web DTO library,
// becomes private (#799), and its qadam-facing symbols are re-exported by the framework (#786).
//
// #786 also adds an ESLint ban for the same thing, which `npm run lint-all` enforces. This scan
// is the backstop the lint rule cannot be: an `// eslint-disable-next-line` (or a file-level
// disable, or an override in a qadam's own eslint config) silences ESLint, and nothing in CI
// would notice. This script reads every file itself and has no disable comment.
//
// It parses with the TypeScript parser, not a regex, so it sees every form a module specifier can
// take and nothing in a comment or a string that merely mentions the name:
//   import … from '@aiqadam/shared' · import '@aiqadam/shared' · export … from '@aiqadam/shared'
//   import x = require('@aiqadam/shared') · require('@aiqadam/shared') · import('@aiqadam/shared')
//   import type … from '@aiqadam/shared'   (types count: #799 bundles them into the framework)
// and any subpath (`@aiqadam/shared/src/...`).
//
// Scope: every source file of every qadam under packages/qadams/{core,community,custom} — `src/`,
// `test/` and config files alike (node_modules, dist and coverage excluded). Tests are included on
// purpose: 15 core qadams lint only `src/**/*.ts`, so the ESLint ban never reaches their `test/`,
// and a test importing `shared` keeps `shared` in the qadam's devDependency graph. A string that
// merely names the package (a vitest `alias` key, a comment) is not an import and is not flagged.
// `packages/qadams/{framework,common}` ARE the SDK and may use `shared` until #799 bundles it.
//
// A full-tree scan, not a diff: once #786 has moved the imports, the tree is clean and must stay
// clean. Zero qadam files scanned is UNKNOWN (exit 2), never a pass — the scan target moved.
//
//   node tools/ci/check-qadam-shared-imports.mjs [--root <dir>]
//
// Tested by tools/ci/test-qadam-shared-imports-check.sh.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community', 'packages/qadams/custom']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
const FORBIDDEN = '@aiqadam/shared'
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/

const main = () => {
  const rootArg = process.argv.indexOf('--root')
  const root = rootArg === -1 ? process.cwd() : path.resolve(process.argv[rootArg + 1])
  const files = QADAM_ROOTS.flatMap((qadamRoot) => listQadamSources({ dir: path.join(root, qadamRoot) }))
  if (files.length === 0) {
    console.error(`[check-qadam-shared-imports] UNKNOWN — no qadam source files under ${QADAM_ROOTS.join(', ')} in ${root}. The scan target moved; refusing to report a clean tree.`)
    process.exitCode = 2
    return
  }
  const findings = files.flatMap((file) => findImports({ file }).map((hit) => ({ file: path.relative(root, file), ...hit })))
  if (findings.length === 0) {
    console.log(`[check-qadam-shared-imports] OK — ${files.length} qadam source files, none imports ${FORBIDDEN}.`)
    return
  }
  const qadams = new Set(findings.map((finding) => finding.file.split('/').slice(0, 4).join('/')))
  console.error(`[check-qadam-shared-imports] ${findings.length} import(s) of ${FORBIDDEN} in ${qadams.size} qadam(s) (ADR-0001 gate 6):\n`)
  for (const finding of findings.slice(0, 50)) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.specifier}`)
    console.error(`::error file=${finding.file},line=${finding.line},title=Qadam imports @aiqadam/shared (ADR-0001 gate 6)::Import it from @aiqadam/qadams-framework instead.`)
  }
  if (findings.length > 50) {
    console.error(`  … and ${findings.length - 50} more`)
  }
  console.error(`\nQadams import only @aiqadam/qadams-framework and @aiqadam/qadams-common. The qadam-facing symbols of ${FORBIDDEN} are re-exported by the framework (#786); import them from there.`)
  process.exitCode = 1
}

const listQadamSources = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => walk({ dir: path.join(dir, entry.name) }))
}

const walk = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : walk({ dir: full })
    }
    return SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

const findImports = ({ file }) => {
  const text = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const hits = []
  const visit = (node) => {
    const specifier = moduleSpecifierOf({ node })
    if (specifier !== null && (specifier === FORBIDDEN || specifier.startsWith(`${FORBIDDEN}/`))) {
      hits.push({ specifier, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return hits
}

const moduleSpecifierOf = ({ node }) => {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return node.moduleSpecifier.text
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
    return node.moduleReference.expression.text
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
    return isRequire || isDynamicImport ? node.arguments[0].text : null
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
    return node.argument.literal.text
  }
  return null
}

main()
