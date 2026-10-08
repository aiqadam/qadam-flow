#!/usr/bin/env node
//
// ADR-0001 gate 2: the level a changeset declares for a package is not below the level CI can
// compute from the change. It can only ever demand a higher level, never accept a lower one.
//
// WHAT IS COMPUTED
// - Qadams (packages/qadams/{core,community}/*): the actions / triggers / props surface, read
//   statically from every `src/**/*.ts` file at the PR's base and head with the TypeScript parser.
//     breaking — an action or trigger removed; a prop removed; a prop's `Property.X` / `QadamAuth.X`
//                factory changed; a prop that became required with no default (optional before,
//                or it lost its default); a new prop that is required with no default; a value
//                removed from a literal `StaticDropdown` / `StaticMultiSelectDropdown` options list.
//     feature  — a new action or trigger; a new optional prop, or a required one with a default.
//     fix      — any other `src/` change.
//   The level that satisfies each follows ADR-0001's table and the 0.x rule: on 0.x a break is a
//   minor and a feature a patch; from 1.0.0 a break is a major and a feature a minor.
// - SDK (`@aiqadam/qadams-framework`, `@aiqadam/qadams-common`): NOT YET. The public `.d.ts` diff
//   is the other half of this gate and is not implemented here (TODO, #797; #786 lists the same
//   deliverable). Until it is, an SDK change is reported as "not computed" and only gate 1 applies.
// - `@aiqadam/shared` and `@aiqadam/platform` have no computable surface; nothing is demanded.
//
// WHAT IT CANNOT SEE — read before trusting a clean run
// - Output shape. Qadams declare no static output schema, so a changed output is invisible.
// - Behaviour. ADR-0001 says so: a behaviour change with an unchanged schema is a question in the
//   PR template and an obligation of the author, not a gate.
// - Props it cannot resolve statically are skipped, never guessed: a prop built by a helper call
//   (`telegramCommons.chatIdProp()`), a config object with a spread or a `required`/`defaultValue`
//   shorthand, a non-literal `required:`, or a `props:` that is not an object literal (then the
//   whole action's props are skipped). Same doctrine and same measured blind spots as
//   tools/ci/check-required-prop-defaults.mjs, whose header lists them.
// - An action or trigger is identified by its literal `name:`, or else by its enclosing
//   `const`/`function` name. One with neither is skipped. If the identity itself moves between
//   the two forms, the gate sees a removal plus an addition and over-estimates (breaking) — the
//   `semver-override` label exists for that.
//
// THE OVERRIDE. A `semver-override` label applied by a maintainer bypasses this gate when it
// over-estimates. ci.yml's `semver-override` job resolves who applied the label and passes the
// verdict in as SEMVER_OVERRIDE:
//   granted:<login>   — applied by a repository admin or maintainer: findings are printed as
//                       warnings and the gate passes. The PR keeps the label, so the use stays visible.
//   denied:<reason>   — present but not applied by a maintainer, or unverifiable: the gate fails.
//   absent / unset    — no label.
//
// Usage:
//   PR_BASE_SHA=<sha> PR_HEAD_SHA=<sha> [SEMVER_OVERRIDE=...] node tools/ci/check-changeset-levels.mjs
//
// Exit: 0 pass (or granted override), 1 declared level too low, 2 UNKNOWN.
//
// Tested by tools/ci/test-changeset-levels-gate.sh.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { changesetGate } from './check-changesets.mjs'

export const changesetLevels = {
  extractSurface: (...args) => extractSurface(...args),
  diffSurfaces: (...args) => diffSurfaces(...args),
  requiredLevel: (...args) => requiredLevel(...args),
}

const QADAM_DIR = /^packages\/qadams\/(core|community)\/[^/]+$/
const SDK_PACKAGES = new Set(['@aiqadam/qadams-framework', '@aiqadam/qadams-common'])
const LEVEL_RANK = { none: 0, patch: 1, minor: 2, major: 3 }
const CREATE_FACTORIES = new Map([['createAction', 'action'], ['createTrigger', 'trigger']])
const PROPERTY_NAMESPACES = new Set(['Property', 'QadamAuth'])
const DROPDOWN_FACTORIES = new Set(['Property.StaticDropdown', 'Property.StaticMultiSelectDropdown'])
const NOT_STATIC = Symbol('not-static')

const main = () => {
  const range = changesetGate.resolveRange()
  const result = tryCatchSync(() => evaluate({ range }))
  if (result.error) {
    console.error(`[check-changeset-levels] UNKNOWN — could not measure ${range.label}: ${result.error.message}`)
    console.error('This is a failure, not a pass.')
    process.exitCode = 2
    return
  }
  const { rows, violations } = result.data
  for (const row of rows) {
    console.log(`  ${row.name}: declared ${row.declared}, computed ${row.computed}${row.note ? ` — ${row.note}` : ''}`)
    for (const finding of row.findings) {
      console.log(`      ${finding.kind === 'breaking' ? 'breaking' : 'feature '}  ${finding.text}`)
    }
  }
  if (violations.length === 0) {
    console.log(`[check-changeset-levels] OK — ${rows.length} package(s) checked, no declared level below the computed one.`)
    return
  }

  const override = parseOverride({ value: process.env.SEMVER_OVERRIDE })
  const lines = violations.map((row) => `${row.name} declares '${row.declared}' but the change needs at least '${row.computed}' (base ${row.baseVersion}: ${row.findings.filter((f) => f.kind === row.drivingKind).map((f) => f.text).slice(0, 3).join('; ')})`)
  if (override.state === 'granted') {
    console.log(`\n[check-changeset-levels] OVERRIDDEN by the semver-override label, applied by @${override.by}. The gate would have demanded:`)
    for (const line of lines) {
      console.log(`  ! ${line}`)
      console.log(`::warning title=semver-override (ADR-0001 gate 2) by @${override.by}::${line}`)
    }
    return
  }
  console.error(`\n[check-changeset-levels] ${violations.length} package(s) declare a level below what the change needs:\n`)
  for (const line of lines) {
    console.error(`  ✗ ${line}`)
    console.error(`::error title=Changeset level too low (ADR-0001 gate 2)::${line}`)
  }
  if (override.state === 'denied') {
    console.error(`\nThe semver-override label is present but does not count: ${override.reason}`)
  }
  console.error('\nRaise the level in the changeset. If CI over-estimates (e.g. a prop moved behind a helper and reads as removed), a maintainer may apply the `semver-override` label; then push a commit — labelling alone does not re-run CI.')
  process.exitCode = 1
}

const evaluate = ({ range }) => {
  const workspace = changesetGate.loadWorkspace({ sha: range.head })
  const declared = changesetGate.declaredLevels({ changesets: changesetGate.readAddedChangesets({ range }) })
  const files = changesetGate.changedFiles({ range })

  const changed = new Map()
  for (const file of files) {
    const pkg = changesetGate.owningPackage({ workspace, file })
    if (pkg && pkg.versioned && file.startsWith(`${pkg.dir}/src/`)) {
      changed.set(pkg.name, pkg)
    }
  }

  const rows = [...changed.values()].map((pkg) => evaluatePackage({ pkg, range, declared: declared.get(pkg.name) ?? 'none' }))
  const violations = rows.filter((row) => row.computed !== null && LEVEL_RANK[row.declared] < LEVEL_RANK[row.computed])
  return { rows, violations }
}

const evaluatePackage = ({ pkg, range, declared }) => {
  if (SDK_PACKAGES.has(pkg.name)) {
    return { name: pkg.name, declared, computed: null, findings: [], note: 'not computed: the SDK public .d.ts diff is not implemented yet (TODO, ADR-0001 gate 2)' }
  }
  if (!QADAM_DIR.test(pkg.dir)) {
    return { name: pkg.name, declared, computed: null, findings: [], note: 'no computable surface' }
  }
  const baseManifest = readJson({ text: changesetGate.readFileAt({ sha: range.base, file: `${pkg.dir}/package.json` }) })
  if (baseManifest === null) {
    return { name: pkg.name, declared, computed: null, findings: [], note: 'new package, nothing to compare against' }
  }
  const base = extractSurface({ files: readSources({ sha: range.base, dir: pkg.dir }) })
  const head = extractSurface({ files: readSources({ sha: range.head, dir: pkg.dir }) })
  const findings = diffSurfaces({ base, head })
  const kind = findings.some((finding) => finding.kind === 'breaking') ? 'breaking' : findings.some((finding) => finding.kind === 'feature') ? 'feature' : 'fix'
  const computed = requiredLevel({ kind, baseVersion: baseManifest.version })
  return { name: pkg.name, declared, computed, findings, drivingKind: kind, baseVersion: baseManifest.version }
}

// ADR-0001's table plus the 0.x rule (minor is the breaking slot below 1.0.0).
const requiredLevel = ({ kind, baseVersion }) => {
  const major = Number(/^(\d+)\./.exec(String(baseVersion))?.[1])
  if (!Number.isInteger(major)) {
    throw new Error(`cannot read the major of base version '${baseVersion}'`)
  }
  if (kind === 'breaking') {
    return major === 0 ? 'minor' : 'major'
  }
  if (kind === 'feature') {
    return major === 0 ? 'patch' : 'minor'
  }
  return 'patch'
}

const readSources = ({ sha, dir }) => {
  return listSourceFiles({ sha, dir: `${dir}/src` }).map((file) => ({ file, text: changesetGate.readFileAt({ sha, file }) ?? '' }))
}

const listSourceFiles = ({ sha, dir }) => {
  const text = changesetGate.readFileAt({ sha, file: dir })
  if (text === null) {
    return []
  }
  // `git show <sha>:<dir>` prints a tree listing: a header line, a blank line, then one entry per
  // line with directories suffixed by `/`.
  return text.split('\n').slice(2).filter(Boolean).flatMap((entry) => {
    if (entry.endsWith('/')) {
      return listSourceFiles({ sha, dir: `${dir}/${entry.slice(0, -1)}` })
    }
    const file = `${dir}/${entry}`
    return file.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(file) && !file.endsWith('.d.ts') ? [file] : []
  })
}

// Map<`${kind}:${name}`, { kind, name, resolvable, props: Map<key, PropShape> }>. A key defined
// twice is marked ambiguous and treated as unresolvable rather than pairing the wrong two.
const extractSurface = ({ files }) => {
  const surface = new Map()
  const seen = new Set()
  for (const { file, text } of files) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      const call = asFactoryCall({ node })
      if (call) {
        const key = `${call.kind}:${call.name}`
        const entry = { kind: call.kind, name: call.name, ...readProps({ objectLiteral: call.config }) }
        surface.set(key, seen.has(key) ? { ...entry, resolvable: false, ambiguous: true, props: new Map() } : entry)
        seen.add(key)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return surface
}

const diffSurfaces = ({ base, head }) => {
  const findings = []
  for (const [key, before] of base) {
    const after = head.get(key)
    if (!after) {
      findings.push({ kind: 'breaking', text: `${before.kind} '${before.name}' removed` })
      continue
    }
    if (!before.resolvable || !after.resolvable) {
      continue
    }
    for (const [prop, was] of before.props) {
      const now = after.props.get(prop)
      if (!now) {
        findings.push({ kind: 'breaking', text: `${before.name}.${prop} removed` })
        continue
      }
      if (!was.resolvable || !now.resolvable) {
        continue
      }
      if (was.factory !== now.factory) {
        findings.push({ kind: 'breaking', text: `${before.name}.${prop} changed ${was.factory} -> ${now.factory}` })
      }
      if (now.required && !now.hasDefault && !(was.required && !was.hasDefault)) {
        findings.push({ kind: 'breaking', text: `${before.name}.${prop} became required with no default` })
      }
      if (was.options && now.options) {
        const lost = was.options.filter((value) => !now.options.includes(value))
        if (lost.length > 0) {
          findings.push({ kind: 'breaking', text: `${before.name}.${prop} dropdown value(s) removed: ${lost.join(', ')}` })
        }
      }
    }
    for (const [prop, now] of after.props) {
      if (before.props.has(prop)) {
        continue
      }
      if (now.resolvable && now.required && !now.hasDefault) {
        findings.push({ kind: 'breaking', text: `${before.name}.${prop} added as required with no default` })
      }
      else {
        findings.push({ kind: 'feature', text: `${before.name}.${prop} added` })
      }
    }
  }
  for (const [key, after] of head) {
    if (!base.has(key)) {
      findings.push({ kind: 'feature', text: `${after.kind} '${after.name}' added` })
    }
  }
  return findings
}

const asFactoryCall = ({ node }) => {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !CREATE_FACTORIES.has(node.expression.text)) {
    return null
  }
  const [config] = node.arguments
  if (!config || !ts.isObjectLiteralExpression(config)) {
    return null
  }
  const kind = CREATE_FACTORIES.get(node.expression.text)
  const nameProperty = findProperty({ objectLiteral: config, name: 'name' })
  if (nameProperty && ts.isStringLiteralLike(nameProperty.initializer)) {
    return { kind, name: nameProperty.initializer.text, config }
  }
  const enclosing = findEnclosingDeclarationName({ node })
  return enclosing === null ? null : { kind, name: `decl:${enclosing}`, config }
}

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

const readProps = ({ objectLiteral }) => {
  const propsProperty = findProperty({ objectLiteral, name: 'props' })
  if (!propsProperty) {
    return { resolvable: true, props: new Map() }
  }
  if (!ts.isObjectLiteralExpression(propsProperty.initializer)) {
    return { resolvable: false, props: new Map() }
  }
  const entries = propsProperty.initializer.properties
    .filter((property) => ts.isPropertyAssignment(property) && property.name)
    .map((property) => [propertyKey({ name: property.name }), readPropShape({ initializer: property.initializer })])
  // A spread at the props level contributes keys this cannot see; the listed keys are still
  // compared, but a key that "disappears" might have moved into the spread, so removals are not
  // trustworthy — mark the whole action unresolvable instead of reporting a false break.
  const hasSpread = propsProperty.initializer.properties.some((property) => ts.isSpreadAssignment(property))
  return { resolvable: !hasSpread, props: new Map(entries) }
}

const readPropShape = ({ initializer }) => {
  const unresolvable = { resolvable: false }
  if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression) || !ts.isIdentifier(initializer.expression.expression) || !PROPERTY_NAMESPACES.has(initializer.expression.expression.text)) {
    return unresolvable
  }
  const factory = `${initializer.expression.expression.text}.${initializer.expression.name.text}`
  const [arg] = initializer.arguments
  if (!arg || !ts.isObjectLiteralExpression(arg) || hasHazard({ objectLiteral: arg })) {
    return { ...unresolvable, factory }
  }
  const required = readBoolean({ node: findProperty({ objectLiteral: arg, name: 'required' })?.initializer })
  if (required === NOT_STATIC) {
    return { ...unresolvable, factory }
  }
  return { resolvable: true, factory, required, hasDefault: hasDefaultValue({ objectLiteral: arg }), options: DROPDOWN_FACTORIES.has(factory) ? readOptionValues({ objectLiteral: arg }) : null }
}

// `options: { options: [{ label, value: <literal> }, ...] }` only; anything dynamic is null (not compared).
const readOptionValues = ({ objectLiteral }) => {
  const outer = findProperty({ objectLiteral, name: 'options' })?.initializer
  if (!outer || !ts.isObjectLiteralExpression(outer)) {
    return null
  }
  const list = findProperty({ objectLiteral: outer, name: 'options' })?.initializer
  if (!list || !ts.isArrayLiteralExpression(list)) {
    return null
  }
  const values = list.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) {
      return NOT_STATIC
    }
    const value = findProperty({ objectLiteral: element, name: 'value' })?.initializer
    if (value && (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value))) {
      return JSON.stringify(value.text)
    }
    if (value && (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)) {
      return String(value.kind === ts.SyntaxKind.TrueKeyword)
    }
    return NOT_STATIC
  })
  return values.includes(NOT_STATIC) ? null : values
}

const hasHazard = ({ objectLiteral }) => objectLiteral.properties.some((property) => ts.isSpreadAssignment(property)
  || (ts.isShorthandPropertyAssignment(property) && ['required', 'defaultValue', 'options'].includes(property.name.text)))

const hasDefaultValue = ({ objectLiteral }) => {
  const initializer = findProperty({ objectLiteral, name: 'defaultValue' })?.initializer
  if (!initializer) {
    return false
  }
  if (initializer.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(initializer)) {
    return false
  }
  if (ts.isIdentifier(initializer) && initializer.text === 'undefined') {
    return false
  }
  return !(ts.isStringLiteralLike(initializer) && initializer.text === '')
}

const readBoolean = ({ node }) => {
  if (!node || node.kind === ts.SyntaxKind.FalseKeyword) {
    return false
  }
  return node.kind === ts.SyntaxKind.TrueKeyword ? true : NOT_STATIC
}

const findProperty = ({ objectLiteral, name }) => objectLiteral.properties.find((property) => ts.isPropertyAssignment(property) && property.name && propertyKey({ name: property.name }) === name)

const propertyKey = ({ name }) => (ts.isStringLiteralLike(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name) ? name.text : name.getText())

const parseOverride = ({ value }) => {
  if (!value || value === 'absent') {
    return { state: 'absent' }
  }
  const granted = /^granted:([A-Za-z0-9-]+(?:\[bot\])?)$/.exec(value)
  if (granted) {
    return { state: 'granted', by: granted[1] }
  }
  return { state: 'denied', reason: value.replace(/^denied:/, '') }
}

const readJson = ({ text }) => {
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
