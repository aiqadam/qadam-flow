#!/usr/bin/env node
//
// ADR-0001 gate 7: compatibility floors are consistent with the platform. For every qadam under
// packages/qadams/{core,community}:
//   effective minimumSupportedRelease <= platform version
//   maximumSupportedRelease >= platform version          (when set)
//
// EFFECTIVE, not declared. The framework's `Qadam` constructor raises any declared floor below
// `MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION` (and a missing or non-semver one) to
// that constant (packages/qadams/framework/src/lib/qadam.ts, the `isSemverLessThan` clamp;
// constant in src/lib/context/versioning.ts) — so the '0.0.0' that 234 of 238 qadams declare is
// 0.82.0 in `metadata()`, which is what the server filters on. This script reads the constant
// from the framework source and applies the same max(), rather than building and loading 238
// qadams to call metadata(); tools/ci/test-compat-floors-check.sh pins that the two agree on the
// clamp's cases. A framework that no longer exports the constant as a string literal is UNKNOWN
// (exit 2): the clamp moved, and this gate must be updated with it rather than guess.
// where the platform version is the root package.json's — the last released version under
// ADR-0001, i.e. what `apVersionUtil.getCurrentRelease()` reports and `isSupportedRelease` filters
// the catalogue against. A qadam failing either side is hidden from the catalogue of the very
// platform it ships in, which is how the inherited Activepieces floor once emptied
// `GET /api/v1/qadams` (#776).
//
// Both values must also be string literals holding valid semver: the server compares them with
// semver, and a value this script cannot read statically is one nobody can audit (#800's floor
// audit). A non-literal value is a failure, not a skip.
//
// What it does NOT check: whether a floor is the RIGHT floor (that a qadam really works on the
// release it names) — that needs the qadam run against that release. Nor whether the framework's
// own floor constant is right — that is #800's audit; this gate only applies it.
//
//   node tools/ci/check-compat-floors.mjs [--root <dir>]
//
// Exit: 0 pass, 1 inconsistent floor, 2 UNKNOWN (no qadams found, unreadable platform version).
//
// Tested by tools/ci/test-compat-floors-check.sh.
import fs from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import ts from 'typescript'

const QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
const CLAMP_FILE = 'packages/qadams/framework/src/lib/context/versioning.ts'
const CLAMP_CONSTANT = 'MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION'
const FIELDS = ['minimumSupportedRelease', 'maximumSupportedRelease']

const main = () => {
  const rootArg = process.argv.indexOf('--root')
  const rootValue = rootArg === -1 ? null : process.argv[rootArg + 1]
  if (rootValue !== null && (!rootValue || rootValue.startsWith('--'))) {
    console.error('[check-compat-floors] UNKNOWN — --root needs a directory argument (a bare --root or one followed by another flag cannot be measured).')
    process.exitCode = 2
    return
  }
  const root = rootValue === null ? process.cwd() : path.resolve(rootValue)
  const platform = readPlatformVersion({ root })
  if (platform === null) {
    console.error(`[check-compat-floors] UNKNOWN — the root package.json in ${root} has no valid semver "version".`)
    process.exitCode = 2
    return
  }
  const clamp = readClamp({ root })
  if (clamp === null) {
    console.error(`[check-compat-floors] UNKNOWN — ${CLAMP_FILE} no longer exports ${CLAMP_CONSTANT} as a semver string literal, so the effective floor the framework applies cannot be computed. Update this gate together with the clamp.`)
    process.exitCode = 2
    return
  }
  const qadamDirs = QADAM_ROOTS.flatMap((qadamRoot) => listDirs({ dir: path.join(root, qadamRoot) }))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
  if (qadamDirs.length === 0) {
    console.error(`[check-compat-floors] UNKNOWN — no qadams under ${QADAM_ROOTS.join(', ')} in ${root}.`)
    process.exitCode = 2
    return
  }

  const problems = []
  let declaring = 0
  for (const dir of qadamDirs) {
    const floors = readFloors({ dir })
    const rel = path.relative(root, dir)
    for (const issue of floors.issues) {
      problems.push(`${rel}: ${issue}`)
    }
    if (floors.min !== undefined || floors.max !== undefined) {
      declaring++
    }
    const effectiveMin = floors.min && semver.gt(floors.min, clamp) ? floors.min : clamp
    if (semver.gt(effectiveMin, platform)) {
      const how = effectiveMin === floors.min ? 'declared' : `the framework's floor (${CLAMP_CONSTANT}; declared ${floors.min ?? 'nothing'})`
      problems.push(`${rel}: effective minimumSupportedRelease ${effectiveMin} (${how}) is above the platform version ${platform} — this qadam would be hidden from the catalogue of the release it ships in`)
    }
    if (floors.max && semver.lt(floors.max, platform)) {
      problems.push(`${rel}: maximumSupportedRelease ${floors.max} is below the platform version ${platform} — this qadam would be hidden from the catalogue of the release it ships in`)
    }
    if (floors.max && semver.gt(effectiveMin, floors.max)) {
      problems.push(`${rel}: effective minimumSupportedRelease ${effectiveMin} is above maximumSupportedRelease ${floors.max}`)
    }
  }

  if (problems.length === 0) {
    console.log(`[check-compat-floors] OK — ${qadamDirs.length} qadams (${declaring} declare a floor or ceiling; the framework raises any floor below ${clamp} to ${clamp}), all consistent with platform ${platform}.`)
    return
  }
  console.error(`[check-compat-floors] ${problems.length} inconsistent compatibility floor(s) against platform ${platform} (ADR-0001 gate 7):\n`)
  for (const problem of problems) {
    console.error(`  ✗ ${problem}`)
    console.error(`::error title=Compatibility floor (ADR-0001 gate 7)::${problem}`)
  }
  process.exitCode = 1
}

const readPlatformVersion = ({ root }) => {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    return typeof version === 'string' && semver.valid(version) ? version : null
  }
  catch {
    return null
  }
}

const readClamp = ({ root }) => {
  const file = path.join(root, CLAMP_FILE)
  if (!fs.existsSync(file)) {
    return null
  }
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const values = sourceFile.statements
    .filter((statement) => ts.isVariableStatement(statement))
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === CLAMP_CONSTANT && declaration.initializer && ts.isStringLiteralLike(declaration.initializer))
    .map((declaration) => declaration.initializer.text)
  return values.length === 1 && semver.valid(values[0]) ? values[0] : null
}

const listDirs = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name))
}

const walk = ({ dir }) => {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : walk({ dir: full })
    }
    return /\.ts$/.test(entry.name) && !/\.(d|test|spec)\.ts$/.test(entry.name) ? [full] : []
  })
}

// A property name as written, not as printed: `minimumSupportedRelease`, `'minimumSupportedRelease'`
// and `"minimumSupportedRelease"` are the same key, and reading only the source text would silently
// skip the quoted spellings (the shape that made a 9.9.9 floor pass gate 7).
const propertyKey = ({ name }) => (ts.isStringLiteralLike(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name) ? name.text : name.getText())

// Every `createQadam({ ... })` in the qadam's src. A floor declared in more than one call (or a
// call whose config is not an object literal) is reported rather than resolved by guessing.
const readFloors = ({ dir }) => {
  const issues = []
  const found = { min: [], max: [] }
  for (const file of walk({ dir: path.join(dir, 'src') })) {
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createQadam') {
        const [config] = node.arguments
        if (!config || !ts.isObjectLiteralExpression(config)) {
          issues.push(`createQadam in ${path.basename(file)} has no object-literal config, so its floors cannot be read`)
        }
        else {
          for (const field of FIELDS) {
            const property = config.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && propertyKey({ name: p.name }) === field)
            if (!property) {
              continue
            }
            const value = ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null
            if (value === null) {
              issues.push(`${field} is not a string literal (${property.getText()}) — it cannot be audited`)
            }
            else if (!semver.valid(value)) {
              issues.push(`${field} '${value}' is not a valid semver version`)
            }
            else {
              found[field === FIELDS[0] ? 'min' : 'max'].push(value)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  if (found.min.length > 1 || found.max.length > 1) {
    issues.push('more than one createQadam declares a floor or ceiling')
  }
  return { issues, min: found.min[0], max: found.max[0] }
}

main()
