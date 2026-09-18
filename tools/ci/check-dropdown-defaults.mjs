#!/usr/bin/env node
//
// Static scan for #427: a `StaticDropdown`/`StaticMultiSelectDropdown` property whose own
// `defaultValue` is not one of the options that same property declares. The builder seeds
// every form field from `defaultValue`, so a mismatch hands the user a default the property's
// own option list says is invalid — three confirmed cases (`@aiqadam/qadam-nocodb`'s `version`,
// `@aiqadam/qadam-clickup`'s `visibility` on two actions, `@aiqadam/qadam-freshdesk`'s
// `filter_type`/`filter_status`) were found by manual review with no guarantee the set is
// complete, since ~900 declarations exist across ~240 qadams and no scan had ever run.
//
// This is a static AST scan over source, not a runtime import of built qadams: the repo
// deliberately keeps `turbo run test`'s dependency graph to `^build` (each package's own
// dependencies) rather than `build` (every package, including qadams nothing in the graph
// otherwise needs), specifically to avoid a CI cost the equivalent runtime check would
// reintroduce — see the `test` task's comment in turbo.json. A static scan reads `.ts` text and
// needs nothing built.
//
// The trade-off of staying static: only a property whose `options` is a literal array of
// `{ value: <literal> }` entries and whose `defaultValue` is itself a literal is checked. A
// dropdown built from a `.map()`, a spread of an imported constant, or any other non-literal
// expression is skipped rather than guessed at — a false "no violation" is the safe failure
// mode here, a false positive blocking every PR touching that file is not. `readLiteral` only
// recognises string/numeric/boolean literals, so a negative number (`-1`, a `PrefixUnaryExpression`)
// or a `null`/`as const` default also falls into that same "skip" path, silently — a real
// mismatch there would not be caught. None exist in the tree today.
//
// Values are compared with `String(declared) === String(defaultLiteral)`, the same loose,
// type-coercing comparison `piecePropertiesUtils.buildSchema` uses at request-validation time
// (`packages/qadams/framework/src/lib/property/util.ts`), so anything this script accepts is
// also accepted by the server. It does mean a number and its string spelling (or a boolean and
// its spelling) are treated as equal, matching the builder's own leniency there.
//
// Usage:
//   node tools/ci/check-dropdown-defaults.mjs
//   node tools/ci/check-dropdown-defaults.mjs --root <dir>   # used by the fixture tests
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const QADAM_ROOTS = ['packages/qadams/community', 'packages/qadams/core']
const DROPDOWN_FACTORIES = new Set(['StaticDropdown', 'StaticMultiSelectDropdown'])

const main = () => {
  const options = parseArgs({ argv: process.argv.slice(2) })
  const root = options.root ?? REPO_ROOT

  const files = QADAM_ROOTS.flatMap((qadamRoot) => listSourceFiles({ dir: path.join(root, qadamRoot) }))
  const violations = files.flatMap((file) => scanFile({ file, root }))

  if (violations.length === 0) {
    console.log(`[check-dropdown-defaults] OK — scanned ${files.length} files, no defaultValue/options mismatches found.`)
    return
  }

  console.error(`[check-dropdown-defaults] ${violations.length} defaultValue/options mismatch(es):\n`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — defaultValue ${violation.defaultValue} is not one of the declared options [${violation.declaredOptions.join(', ')}]`)
  }
  console.error('\nEither add the default to the property\'s own `options`, or drop `defaultValue` if the value is a deliberate "unset" sentinel.')
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
    if (entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) && !fullPath.endsWith('.test.ts') && !fullPath.endsWith('.spec.ts')) {
      return [fullPath]
    }
    return []
  })
}

const scanFile = ({ file, root }) => {
  const text = fs.readFileSync(file, 'utf-8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const violations = []

  const visit = (node) => {
    const dropdownCall = asDropdownFactoryCall({ node })
    if (dropdownCall) {
      const violation = checkDropdownCall({ callNode: dropdownCall, sourceFile, file, root })
      if (violation) {
        violations.push(violation)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

const asDropdownFactoryCall = ({ node }) => {
  if (!ts.isCallExpression(node)) {
    return null
  }
  const { expression } = node
  if (!ts.isPropertyAccessExpression(expression)) {
    return null
  }
  if (expression.expression.getText() !== 'Property' || !DROPDOWN_FACTORIES.has(expression.name.text)) {
    return null
  }
  const [arg] = node.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return null
  }
  return { configObject: arg, isMultiSelect: expression.name.text === 'StaticMultiSelectDropdown' }
}

const checkDropdownCall = ({ callNode, sourceFile, file, root }) => {
  const defaultValueProp = findProperty({ objectLiteral: callNode.configObject, name: 'defaultValue' })
  if (!defaultValueProp) {
    return null
  }
  const defaultLiterals = readLiterals({ node: defaultValueProp.initializer, allowArray: callNode.isMultiSelect })
  if (defaultLiterals === null) {
    // Not a statically-resolvable default (an identifier, a call, a template with
    // substitutions, …) — nothing to check.
    return null
  }

  const optionsProp = findProperty({ objectLiteral: callNode.configObject, name: 'options' })
  if (!optionsProp || !ts.isObjectLiteralExpression(optionsProp.initializer)) {
    return null
  }
  const optionsListProp = findProperty({ objectLiteral: optionsProp.initializer, name: 'options' })
  if (!optionsListProp || !ts.isArrayLiteralExpression(optionsListProp.initializer)) {
    return null
  }

  const declaredValues = []
  for (const element of optionsListProp.initializer.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      return null // a spread or computed entry — can't be sure the list is exhaustive
    }
    const valueProp = findProperty({ objectLiteral: element, name: 'value' })
    if (!valueProp) {
      return null
    }
    const literal = readLiteral({ node: valueProp.initializer })
    if (literal === NOT_STATIC) {
      return null // an entry's value isn't statically known — stay silent rather than guess
    }
    declaredValues.push(literal)
  }
  if (declaredValues.length === 0) {
    return null
  }

  const unmatched = defaultLiterals.filter((defaultLiteral) => !declaredValues.some((declared) => String(declared) === String(defaultLiteral)))
  if (unmatched.length === 0) {
    return null
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(defaultValueProp.getStart(sourceFile))
  return {
    file: path.relative(root, file),
    line: line + 1,
    defaultValue: JSON.stringify(callNode.isMultiSelect ? defaultLiterals : defaultLiterals[0]),
    declaredOptions: declaredValues.map((v) => JSON.stringify(v)),
  }
}

const findProperty = ({ objectLiteral, name }) => {
  return objectLiteral.properties.find((p) => ts.isPropertyAssignment(p) && p.name && p.name.getText() === name)
}

const NOT_STATIC = Symbol('not-static')

const readLiteral = ({ node }) => {
  if (ts.isStringLiteralLike(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  return NOT_STATIC
}

// `allowArray` covers STATIC_MULTI_SELECT_DROPDOWN, whose defaultValue is an array of the
// individually-declared option values.
const readLiterals = ({ node, allowArray }) => {
  if (allowArray && ts.isArrayLiteralExpression(node)) {
    const values = []
    for (const element of node.elements) {
      const literal = readLiteral({ node: element })
      if (literal === NOT_STATIC) {
        return null
      }
      values.push(literal)
    }
    return values
  }
  const literal = readLiteral({ node })
  return literal === NOT_STATIC ? null : [literal]
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
