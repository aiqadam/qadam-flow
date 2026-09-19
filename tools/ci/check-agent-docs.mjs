#!/usr/bin/env node
//
// Wiring gate for the agent-facing docs under `.agents/`.
//
// The failure this exists to stop is not a typo, it is drift: a skill or a subagent charter
// that exists on disk, is named in no routing table, carries a description no harness can
// trigger on, and is therefore never used by anybody. That is the state this repo was
// actually in — seven of fourteen skills were referenced nowhere outside their own directory
// (the other seven only by the one AGENTS.md table row that named five of them, plus two
// path mentions in docs/README.md), two shipped with no YAML frontmatter at all (so their
// "description" was whatever the harness derived from the H1: "Browser Testing with
// agent-browser"), and three of five charters had no documented trigger. Nothing was red,
// because nothing was checked.
//
// So this checks the wiring, and only the wiring:
//
//   1. every `.agents/skills/<name>/SKILL.md` has frontmatter whose `name` is exactly
//      <name>, and a `description` long enough and specific enough to trigger on;
//   2. every `.agents/agents/<name>.md` has the same, with `name` matching the filename;
//   3. the skill set on disk matches the trigger registry in `.agents/rules/skill-usage.md`,
//      in both directions — no unlisted skill, no phantom row;
//   4. the charter set on disk matches the delegation matrix in
//      `.agents/rules/agent-delegation.md`, in both directions;
//   5. every `.agents/rules/*.md` appears in the rules index in AGENTS.md, in both
//      directions;
//   6. every `.agents/docs/*.md` is linked from AGENTS.md;
//   7. every skill or charter a per-package `AGENTS.md` routes to actually exists — those
//      routing tables are the whole point of the change and would otherwise sit outside the
//      gate, going stale on the first rename;
//   8. `.claude/` and `.cursor/` are still symlink mirrors into `.agents/`, not copies
//      somebody edited by hand.
//
// It cannot check that an agent actually opened a skill it should have. That part is on the
// agent, and on the wording of `.agents/rules/skill-usage.md`. What it can guarantee is that
// the skill was findable, triggerable, and listed where an agent is told to look — i.e. that
// a skipped skill is a choice rather than an accident.
//
// Usage:
//   node tools/ci/check-agent-docs.mjs
//   node tools/ci/check-agent-docs.mjs --root <dir>   # used by the fixture tests
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

const SKILLS_DIR = '.agents/skills'
const AGENTS_DIR = '.agents/agents'
const RULES_DIR = '.agents/rules'
const DOCS_DIR = '.agents/docs'
const SKILL_REGISTRY = '.agents/rules/skill-usage.md'
const SKILL_REGISTRY_HEADING = 'Trigger registry'
const AGENT_REGISTRY = '.agents/rules/agent-delegation.md'
const AGENT_REGISTRY_HEADING = 'When: the delegation matrix'
const ROOT_DOC = 'AGENTS.md'
const RULES_INDEX_HEADING = 'Every rule, and what it stops you doing'

// A description is the only thing a harness reads when deciding whether to load a skill. Two
// failures make it useless, and both shipped here: too short to say anything (a derived H1),
// and no trigger — `playwright-e2e-testing` described the framework and never said when to
// reach for it. The trigger words are deliberately broad; the point is to force the author to
// write "use when …" at all, not to police the phrasing after that.
const MIN_DESCRIPTION_LENGTH = 40
const TRIGGER_PATTERN = /\buse\s+(this\s+skill\s+)?(when|whenever|before|for|it\b)/i
// The product is Qadam Flow. Upstream's name legitimately appears in prose about the fork and
// its licence, so this is scoped to the one field where it is always wrong: the description a
// user sees in a skill picker.
const FORBIDDEN_IN_DESCRIPTION = 'Activepieces'

// A per-package AGENTS.md routes by naming a skill or charter in prose: "`add-endpoint`
// skill", "the `server` agent", or a path under `.agents/`. Only those three shapes are
// treated as a reference — a bare backticked token is far more often a symbol name than a
// skill, and a gate with false positives on every AGENTS.md is a gate people disable.
const REFERENCE_PATTERNS = [
  { pattern: /`([a-z0-9][a-z0-9-]*)`\s+skill\b/g, kind: 'skill' },
  { pattern: /`([a-z0-9][a-z0-9-]*)`\s+agent\b/g, kind: 'agent' },
  { pattern: /\.agents\/skills\/([a-z0-9][a-z0-9-]*)/g, kind: 'skill' },
  { pattern: /\.agents\/agents\/([a-z0-9][a-z0-9-]*)\.md/g, kind: 'agent' },
]
const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.next'])

const MIRRORS = [
  { link: '.claude/skills', target: SKILLS_DIR },
  { link: '.claude/agents', target: AGENTS_DIR },
  { link: '.claude/rules', target: RULES_DIR },
  { link: '.cursor/skills', target: SKILLS_DIR },
  { link: '.cursor/rules', target: RULES_DIR },
]

const main = () => {
  const options = parseArgs({ argv: process.argv.slice(2) })
  const root = options.root ?? REPO_ROOT

  const problems = [
    ...checkSkills({ root }),
    ...checkAgents({ root }),
    ...checkRulesIndex({ root }),
    ...checkDocsLinked({ root }),
    ...checkRoutingReferences({ root }),
    ...checkMirrors({ root }),
  ]

  if (problems.length === 0) {
    console.log('[check-agent-docs] OK — skills, charters, rules and mirrors are all wired up.')
    return
  }

  console.error(`[check-agent-docs] ${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`)
  for (const problem of problems) {
    console.error(`  ${problem}`)
  }
  console.error('\nSee .agents/rules/skill-usage.md and .agents/rules/agent-delegation.md — a skill or charter')
  console.error('that is not registered is one no agent will ever be told to use.')
  process.exitCode = 1
}

const checkSkills = ({ root }) => {
  const dir = path.join(root, SKILLS_DIR)
  if (!isDirectory(dir)) {
    return [`${SKILLS_DIR}/ does not exist (root: ${root}) — did the directory move?`]
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const problems = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      problems.push(`${SKILLS_DIR}/${entry.name}: a skill is a directory containing SKILL.md, not a loose file.`)
    }
  }

  const skillDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

  // A gate that scanned nothing and reported success is worse than no gate — it would pass
  // every PR forever if `.agents/skills` were ever renamed. Same guard as check-i18n.mjs.
  if (skillDirs.length === 0) {
    return [...problems, `${SKILLS_DIR}/ contains no skills (root: ${root}) — is --root correct, or did they move?`]
  }

  for (const name of skillDirs) {
    const relative = `${SKILLS_DIR}/${name}/SKILL.md`
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) {
      problems.push(`${relative}: missing — every directory under ${SKILLS_DIR}/ must carry a SKILL.md.`)
      continue
    }
    problems.push(...checkFrontmatter({ file, relative, expectedName: name, kind: 'skill' }))
  }

  problems.push(...checkRegistryParity({
    root,
    registry: SKILL_REGISTRY,
    heading: SKILL_REGISTRY_HEADING,
    onDisk: skillDirs,
    label: 'skill',
    fixHint: 'add a row to the trigger registry',
  }))

  return problems
}

const checkAgents = ({ root }) => {
  const dir = path.join(root, AGENTS_DIR)
  if (!isDirectory(dir)) {
    return [`${AGENTS_DIR}/ does not exist (root: ${root}) — did the directory move?`]
  }

  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
  if (files.length === 0) {
    return [`${AGENTS_DIR}/ contains no charters (root: ${root}) — is --root correct, or did they move?`]
  }

  const problems = []
  for (const fileName of files) {
    const relative = `${AGENTS_DIR}/${fileName}`
    problems.push(...checkFrontmatter({
      file: path.join(root, relative),
      relative,
      expectedName: fileName.replace(/\.md$/, ''),
      kind: 'agent',
    }))
  }

  problems.push(...checkRegistryParity({
    root,
    registry: AGENT_REGISTRY,
    heading: AGENT_REGISTRY_HEADING,
    onDisk: files.map((fileName) => fileName.replace(/\.md$/, '')),
    label: 'agent',
    fixHint: 'add a row to the delegation matrix',
  }))

  return problems
}

const checkRulesIndex = ({ root }) => {
  const dir = path.join(root, RULES_DIR)
  if (!isDirectory(dir)) {
    return [`${RULES_DIR}/ does not exist (root: ${root}) — did the directory move?`]
  }

  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
  if (files.length === 0) {
    return [`${RULES_DIR}/ contains no rules (root: ${root}) — is --root correct, or did they move?`]
  }

  return checkRegistryParity({
    root,
    registry: ROOT_DOC,
    heading: RULES_INDEX_HEADING,
    onDisk: files,
    label: 'rule',
    fixHint: `add a row to the rules index in ${ROOT_DOC}`,
  })
}

const checkDocsLinked = ({ root }) => {
  const dir = path.join(root, DOCS_DIR)
  // Returning [] here would make this check silently stop existing the moment the directory
  // is renamed — the same vacuous pass the skills/agents/rules guards above refuse.
  if (!isDirectory(dir)) {
    return [`${DOCS_DIR}/ does not exist (root: ${root}) — did the directory move?`]
  }

  const rootDoc = readFileOrNull(path.join(root, ROOT_DOC))
  if (rootDoc === null) {
    return [`${ROOT_DOC}: missing — it is the entry point every harness reads first.`]
  }

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !rootDoc.includes(`${DOCS_DIR}/${name}`))
    .map((name) => `${DOCS_DIR}/${name}: not linked from ${ROOT_DOC} — a deep dive nothing points at is a deep dive nobody reads.`)
}

const checkRoutingReferences = ({ root }) => {
  const skills = listDirectories(path.join(root, SKILLS_DIR))
  const agents = listMarkdownStems(path.join(root, AGENTS_DIR))
  const known = { skill: skills, agent: agents }

  const problems = []
  for (const relative of findAgentsDocs({ root })) {
    const content = readFileOrNull(path.join(root, relative))
    if (content === null) {
      continue
    }
    content.split('\n').forEach((line, index) => {
      for (const { pattern, kind } of REFERENCE_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const name = match[1]
          if (!known[kind].includes(name)) {
            problems.push(`${relative}:${index + 1}: routes to ${kind} "${name}", which does not exist — a routing table that outlives the file it points at is worse than none.`)
          }
        }
      }
    })
  }
  return problems
}

const findAgentsDocs = ({ root }) => {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_IGNORE.has(entry.name) && !entry.isSymbolicLink()) {
          walk(path.join(dir, entry.name))
        }
        continue
      }
      if (entry.name === 'AGENTS.md') {
        found.push(path.relative(root, path.join(dir, entry.name)))
      }
    }
  }
  walk(root)
  return found.sort()
}

const listDirectories = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  }
  catch {
    return []
  }
}

const listMarkdownStems = (dir) => {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => name.replace(/\.md$/, ''))
  }
  catch {
    return []
  }
}

const checkMirrors = ({ root }) => {
  const problems = []
  for (const { link, target } of MIRRORS) {
    const linkPath = path.join(root, link)
    let stats
    try {
      stats = fs.lstatSync(linkPath)
    }
    catch {
      problems.push(`${link}: missing — it must be a symlink to ${target} so the harness auto-discovers it.`)
      continue
    }
    if (!stats.isSymbolicLink()) {
      problems.push(`${link}: not a symlink. ${target} is the single source; a real directory here is a second copy that will drift.`)
      continue
    }
    const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))
    if (resolved !== path.join(root, target)) {
      problems.push(`${link}: points at ${path.relative(root, resolved)}, expected ${target}.`)
    }
  }
  return problems
}

const checkRegistryParity = ({ root, registry, heading, onDisk, label, fixHint }) => {
  const content = readFileOrNull(path.join(root, registry))
  if (content === null) {
    return [`${registry}: missing — it is the ${label} registry, and the gate has nothing to compare against.`]
  }

  const listed = collectTableKeys({ content, heading })
  if (listed === null) {
    return [`${registry}: no table found under a heading containing "${heading}" — the ${label} registry cannot be parsed.`]
  }

  const problems = []
  for (const name of onDisk) {
    if (!listed.has(name)) {
      problems.push(`${label} "${name}" exists on disk but is missing from ${registry} — ${fixHint}, or delete it.`)
    }
  }
  for (const name of listed) {
    if (!onDisk.includes(name)) {
      problems.push(`${registry} lists ${label} "${name}", which does not exist on disk — remove the row, or restore the file.`)
    }
  }
  return problems
}

// Returns the set of backticked identifiers in the first column of the first markdown table
// following `heading`, or null when no such table exists. Deliberately dumb: the registries
// are hand-written tables, and a parser that guesses would hide exactly the drift this gate
// is here to surface.
const collectTableKeys = ({ content, heading }) => {
  const lines = content.split('\n')
  const headingIndex = lines.findIndex((line) => line.startsWith('#') && line.includes(heading))
  if (headingIndex === -1) {
    return null
  }

  const keys = new Set()
  let inTable = false
  for (const line of lines.slice(headingIndex + 1)) {
    const isRow = line.trimStart().startsWith('|')
    if (!isRow) {
      if (inTable) {
        break
      }
      if (line.startsWith('#')) {
        return null
      }
      continue
    }
    inTable = true
    const firstCell = line.trim().replace(/^\|/, '').split('|')[0] ?? ''
    if (/^[\s:|-]*$/.test(firstCell)) {
      continue
    }
    const match = firstCell.match(/`([^`]+)`/)
    if (match !== null) {
      keys.add(match[1])
    }
  }
  return inTable ? keys : null
}

const checkFrontmatter = ({ file, relative, expectedName, kind }) => {
  const content = readFileOrNull(file)
  if (content === null) {
    return [`${relative}: unreadable.`]
  }

  const frontmatter = parseFrontmatter({ content })
  if (frontmatter === null) {
    return [`${relative}: no YAML frontmatter. Without it the harness invents a description from the H1, and the ${kind} never triggers.`]
  }

  const problems = []
  const name = frontmatter.name ?? ''
  const description = frontmatter.description ?? ''

  if (name === '') {
    problems.push(`${relative}: frontmatter has no "name".`)
  }
  else if (name !== expectedName) {
    problems.push(`${relative}: frontmatter name is "${name}", expected "${expectedName}" — the registries key on the path, so a mismatch routes nowhere.`)
  }

  if (description === '') {
    problems.push(`${relative}: frontmatter has no "description".`)
    return problems
  }
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    problems.push(`${relative}: description is ${description.length} characters; at least ${MIN_DESCRIPTION_LENGTH} are needed to say what this ${kind} does and when to use it.`)
  }
  if (!TRIGGER_PATTERN.test(description)) {
    problems.push(`${relative}: description states no trigger. Say "Use when …" / "Use before …" — a description that only names the topic is one no agent can act on.`)
  }
  if (description.includes(FORBIDDEN_IN_DESCRIPTION)) {
    problems.push(`${relative}: description says "${FORBIDDEN_IN_DESCRIPTION}". The product is Qadam Flow.`)
  }

  return problems
}

// Minimal frontmatter reader: top-level `key: value` scalars, with folded continuation lines
// (the mintlify skill wraps its description across three lines). Nested blocks are consumed
// as part of their parent's value and ignored, which is all this gate needs.
const parseFrontmatter = ({ content }) => {
  if (!content.startsWith('---\n')) {
    return null
  }
  const end = content.indexOf('\n---', 3)
  if (end === -1) {
    return null
  }

  const fields = {}
  let currentKey = null
  for (const line of content.slice(4, end).split('\n')) {
    const keyed = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (keyed !== null) {
      currentKey = keyed[1]
      fields[currentKey] = keyed[2].trim()
      continue
    }
    if (currentKey !== null && /^\s+\S/.test(line)) {
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim()
    }
  }

  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, unquote(value)]))
}

const unquote = (value) => {
  const trimmed = value.trim()
  const quoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  return quoted ? trimmed.slice(1, -1) : trimmed
}

const readFileOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  }
  catch {
    return null
  }
}

const isDirectory = (dir) => {
  try {
    return fs.statSync(dir).isDirectory()
  }
  catch {
    return false
  }
}

const parseArgs = ({ argv }) => {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root') {
      options.root = path.resolve(argv[index + 1] ?? '')
      index++
    }
  }
  return options
}

main()
