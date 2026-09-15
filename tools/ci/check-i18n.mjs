#!/usr/bin/env node
//
// Parity checker for the UI locales and the qadam i18n catalogs (#416).
//
// Web catalogs (packages/web/public/locales) are hand-maintained since Crowdin was
// dropped, so every key in `en/translation.json` must exist in all three other
// locales with a real translation. Qadam catalogs are translated per-locale when
// someone volunteers the work, so coverage is NOT required there — but every
// `<locale>.json` that exists must only contain keys its `translation.json` declares,
// with non-empty values.
//
// Usage:
//   node tools/ci/check-i18n.mjs                 # check
//   node tools/ci/check-i18n.mjs --fix           # prune stale keys, then check
//   node tools/ci/check-i18n.mjs --init-allowlist
//   node tools/ci/check-i18n.mjs --root <dir>    # used by the fixture tests
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseIcu, TYPE as ICU_TYPE } from '@formatjs/icu-messageformat-parser'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const SOURCE_LOCALE = 'en'
const LOCALES_ENUM = path.join('packages', 'shared', 'src', 'lib', 'core', 'common', 'locale.ts')
const WEB_LOCALES = path.join('packages', 'web', 'public', 'locales')
const QADAMS = path.join('packages', 'qadams')
const ALLOWLIST = path.join('tools', 'ci', 'i18n-allowlist.json')
const MAX_EXAMPLES = 10
const SIMPLE_ARGUMENT_TYPES = [ICU_TYPE.argument, ICU_TYPE.number, ICU_TYPE.date, ICU_TYPE.time]

const main = () => {
  const options = parseArgs({ argv: process.argv.slice(2) })
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.initAllowlist) {
    initAllowlist({ root: options.root })
    return
  }
  const allowlist = readAllowlist({ root: options.root })
  const web = checkWeb({ root: options.root, allowlist, fix: options.fix })
  const qadams = checkQadams({ root: options.root, fix: options.fix })
  printReport({ violations: [...web.violations, ...qadams.violations], fixed: [...web.fixed, ...qadams.fixed] })
}

const parseArgs = ({ argv }) => {
  const options = { fix: false, initAllowlist: false, help: false, root: REPO_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--fix') options.fix = true
    else if (arg === '--init-allowlist') options.initAllowlist = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') {
      i++
      if (!argv[i]) throw new Error('--root needs a directory')
      options.root = path.resolve(argv[i])
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const checkWeb = ({ root, allowlist, fix }) => {
  const violations = []
  const fixed = []
  const dirs = listDirs({ dir: path.join(root, WEB_LOCALES) })
  const declared = readLocalesEnum({ root })
  for (const locale of declared) {
    if (!dirs.includes(locale)) violations.push({ scope: 'web', invariant: 'locales-enum', detail: `locale '${locale}' is declared in LocalesEnum but has no ${WEB_LOCALES}/${locale} directory` })
  }
  for (const dir of dirs) {
    if (!declared.includes(dir)) violations.push({ scope: 'web', invariant: 'locales-enum', detail: `directory ${WEB_LOCALES}/${dir} is not declared in LocalesEnum (${declared.join(', ')})` })
  }
  const source = readJson({ file: path.join(root, WEB_LOCALES, SOURCE_LOCALE, 'translation.json') })
  for (const locale of declared.filter((l) => l !== SOURCE_LOCALE)) {
    if (!dirs.includes(locale)) continue
    const file = path.join(root, WEB_LOCALES, locale, 'translation.json')
    const raw = fs.readFileSync(file, 'utf8')
    let catalog = readJson({ file })
    const sourceKeys = Object.keys(source)
    const stale = Object.keys(catalog).filter((key) => !(key in source))
    if (fix && stale.length > 0) {
      catalog = Object.fromEntries(Object.entries(catalog).filter(([key]) => key in source))
      writeJson({ file, value: catalog, trailingNewline: raw.endsWith('\n') })
      fixed.push({ file, detail: `pruned ${stale.length} stale key(s)` })
    }
    const localeKeys = Object.keys(catalog)
    for (const key of sourceKeys.filter((key) => !(key in catalog))) violations.push({ scope: 'web', invariant: 'missing-key', file, detail: JSON.stringify(key) })
    for (const key of localeKeys.filter((key) => !(key in source))) violations.push({ scope: 'web', invariant: 'stale-key', file, detail: JSON.stringify(key) })
    for (const key of localeKeys) {
      if (!(key in source)) continue
      if (catalog[key] === '') violations.push({ scope: 'web', invariant: 'empty-value', file, detail: JSON.stringify(key) })
      if (catalog[key] === source[key] && !isAllowlisted({ allowlist, key, locale })) {
        violations.push({ scope: 'web', invariant: 'untranslated-value', file, detail: `${JSON.stringify(key)} (add to ${ALLOWLIST} with a reason if this is intentional)` })
      }
      const mismatch = compareIcu({ source: source[key], translation: catalog[key] })
      if (mismatch) violations.push({ scope: 'web', invariant: 'icu-arguments', file, detail: `${JSON.stringify(key)}: ${mismatch}` })
    }
  }
  return { violations, fixed }
}

const checkQadams = ({ root, fix }) => {
  const violations = []
  const fixed = []
  const files = walkI18nFiles({ dir: path.join(root, QADAMS) })
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    let catalog = readJson({ file })
    for (const [key, value] of Object.entries(catalog)) {
      if (value === '') violations.push({ scope: 'qadam', invariant: 'empty-value', file, detail: JSON.stringify(key) })
    }
    if (path.basename(file) === 'translation.json') continue
    const sourceFile = path.join(path.dirname(file), 'translation.json')
    if (!fs.existsSync(sourceFile)) {
      violations.push({ scope: 'qadam', invariant: 'missing-source', file, detail: 'no sibling translation.json' })
      continue
    }
    const source = readJson({ file: sourceFile })
    const stale = Object.keys(catalog).filter((key) => !(key in source))
    if (fix && stale.length > 0) {
      catalog = Object.fromEntries(Object.entries(catalog).filter(([key]) => key in source))
      writeJson({ file, value: catalog, trailingNewline: raw.endsWith('\n') })
      fixed.push({ file, detail: `pruned ${stale.length} stale key(s)` })
    }
    for (const key of Object.keys(catalog).filter((key) => !(key in source))) violations.push({ scope: 'qadam', invariant: 'stale-key', file, detail: JSON.stringify(key) })
  }
  return { violations, fixed }
}

const compareIcu = ({ source, translation }) => {
  const sourceArgs = collectIcuArguments({ value: source })
  const translationArgs = collectIcuArguments({ value: translation })
  if (sourceArgs.error) return `source is not valid ICU: ${sourceArgs.error}`
  if (translationArgs.error) return `translation is not valid ICU: ${translationArgs.error}`
  const missing = [...sourceArgs.args].filter((arg) => !translationArgs.args.has(arg))
  const extra = [...translationArgs.args].filter((arg) => !sourceArgs.args.has(arg))
  if (missing.length === 0 && extra.length === 0) return null
  const parts = []
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(`unexpected ${extra.join(', ')}`)
  return `ICU arguments differ (${parts.join('; ')})`
}

// Compared as a set, not a multiset: a plural in ru/kk carries more branches than
// en and repeats the same variable in each branch.
const collectIcuArguments = ({ value }) => {
  let elements
  try {
    elements = parseIcu(value)
  } catch (error) {
    return { args: new Set(), error: error.message }
  }
  const args = new Set()
  const visit = (nodes) => {
    for (const node of nodes) {
      if (SIMPLE_ARGUMENT_TYPES.includes(node.type)) args.add(`${node.value}:${node.type}`)
      else if (node.type === ICU_TYPE.plural || node.type === ICU_TYPE.select) {
        args.add(`${node.value}:${node.type}`)
        for (const option of Object.values(node.options)) visit(option.value)
      }
    }
  }
  visit(elements)
  return { args, error: null }
}

const initAllowlist = ({ root }) => {
  const source = readJson({ file: path.join(root, WEB_LOCALES, SOURCE_LOCALE, 'translation.json') })
  const byKey = new Map()
  for (const locale of listDirs({ dir: path.join(root, WEB_LOCALES) }).filter((l) => l !== SOURCE_LOCALE)) {
    const catalog = readJson({ file: path.join(root, WEB_LOCALES, locale, 'translation.json') })
    for (const [key, value] of Object.entries(catalog)) {
      if (source[key] !== value) continue
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key).push(locale)
    }
  }
  const entries = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, locales]) => ({ key, locales: locales.sort(), reason: classifyAllowlistReason({ key }) }))
  const file = path.join(root, ALLOWLIST)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ entries }, null, 2) + '\n')
  console.log(`wrote ${entries.length} entries to ${ALLOWLIST} — review every reason before committing`)
}

const classifyAllowlistReason = ({ key }) => {
  if (/^[${}[\]:,0-9+./-]+$/.test(key) || key.includes('${')) return 'code or template string'
  if (/^[\d,]+$/.test(key)) return 'numeral'
  if (/^[A-Z][A-Za-z0-9. ()-]*$/.test(key) && !key.includes(' ')) return 'proper noun or acronym'
  return 'proper noun, acronym, or label kept as-is'
}

const isAllowlisted = ({ allowlist, key, locale }) => {
  const entry = allowlist.get(key)
  return Boolean(entry) && (entry.locales.includes(locale) || entry.locales.includes('*'))
}

const readAllowlist = ({ root }) => {
  const file = path.join(root, ALLOWLIST)
  if (!fs.existsSync(file)) return new Map()
  const parsed = readJson({ file })
  return new Map((parsed.entries ?? []).map((entry) => [entry.key, entry]))
}

const readLocalesEnum = ({ root }) => {
  const content = fs.readFileSync(path.join(root, LOCALES_ENUM), 'utf8')
  const declared = [...content.matchAll(/=\s*'([a-z]{2})'/g)].map((match) => match[1])
  if (declared.length === 0) throw new Error(`could not read any locales from ${LOCALES_ENUM}`)
  return declared
}

const walkI18nFiles = ({ dir }) => {
  if (!fs.existsSync(dir)) return []
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walkI18nFiles({ dir: full }))
    else if (entry.isFile() && entry.name.endsWith('.json') && path.basename(dir) === 'i18n') found.push(full)
  }
  return found.sort()
}

const readJson = ({ file }) => JSON.parse(fs.readFileSync(file, 'utf8'))

const writeJson = ({ file, value, trailingNewline }) => {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + (trailingNewline ? '\n' : ''))
}

const listDirs = ({ dir }) =>
  fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

const printReport = ({ violations, fixed }) => {
  for (const item of fixed) console.log(`fix: ${item.file} — ${item.detail}`)
  const scopes = ['web', 'qadam']
  for (const scope of scopes) {
    const items = violations.filter((violation) => violation.scope === scope)
    if (items.length === 0) continue
    console.log(`\n${scope}: ${items.length} violation(s)`)
    const byInvariant = new Map()
    for (const item of items) {
      if (!byInvariant.has(item.invariant)) byInvariant.set(item.invariant, [])
      byInvariant.get(item.invariant).push(item)
    }
    for (const [invariant, bucket] of byInvariant) {
      console.log(`  ${invariant}: ${bucket.length}`)
      for (const item of bucket.slice(0, MAX_EXAMPLES)) console.log(`    ${item.file} — ${item.detail}`)
      if (bucket.length > MAX_EXAMPLES) console.log(`    … and ${bucket.length - MAX_EXAMPLES} more`)
    }
  }
  if (violations.length === 0) {
    console.log(`i18n check passed${fixed.length > 0 ? ` (${fixed.length} file(s) fixed)` : ''}`)
    return
  }
  console.log(`\ni18n check failed: ${violations.length} violation(s). Run with --fix to prune stale keys.`)
  process.exitCode = 1
}

const USAGE = `Usage: node tools/ci/check-i18n.mjs [--fix] [--init-allowlist] [--root <dir>]`

main()
