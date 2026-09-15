#!/usr/bin/env node
//
// Advisory AI review dispatcher for the pre-push hook and `npm run review` (#444).
//
// Three harness-agnostic layers:
//   1. ocr-managed   `ocr` on PATH and an LLM endpoint configured -> `ocr review
//                    --format json --audience agent`. Preferred: deterministic
//                    file selection + rules, ~1/9 the tokens of a generic agent.
//   2. delegation    `ocr` on PATH but no endpoint, plus a known agent CLI
//                    (opencode / claude / codex / cursor-agent). The script runs
//                    OCR's deterministic scaffolding itself (`delegate preview`,
//                    `delegate rule`, `git diff`) and hands the agent a
//                    self-contained prompt, so the agent needs no tools and no
//                    permissions — only its own quota.
//   3. skip          neither is available -> one-line hint, exit 0.
//
// Exit codes are the hook contract:
//   0  review ran (or was skipped) without `critical` findings
//   1  the review itself failed — advisory, it must not block a push
//   2  at least one `critical` finding — the hook asks before pushing anyway
//
// Reviews are advisory by design. A probabilistic reviewer must never become a
// binary gate on top of the deterministic lint/test gate: false-positive-blocked
// pushes train people to SKIP_CHECK=1, which would degrade the real gate.
//
// Usage: node tools/scripts/review.mjs [flags]   (see USAGE below)

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_CRITICAL = 2

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown']

const FINDINGS_OPEN = '<review-findings>'
const FINDINGS_CLOSE = '</review-findings>'

// A batch carries its rule text and diffs in argv, so it stays far below every
// platform's ARG_MAX. A single file larger than this is skipped with a reason
// rather than truncated — a truncated diff would be reviewed as a lie.
const MAX_BATCH_CHARS = 48_000
const DELEGATE_RULE_CHUNK = 100
const DEFAULT_TIMEOUT_MIN = 15
const MAX_AGENT_BUFFER = 64 * 1024 * 1024

const AGENT_ADAPTERS = [
  { name: 'opencode', args: (prompt) => ['run', prompt] },
  { name: 'claude', args: (prompt) => ['-p', prompt] },
  { name: 'codex', args: (prompt) => ['exec', prompt] },
  { name: 'cursor-agent', args: (prompt) => ['-p', prompt] },
]

const USAGE = `Advisory AI review of the current changeset (never blocks by itself).

Usage: node tools/scripts/review.mjs [flags]

Flags:
  --from <ref>            review range, e.g. --from main (--to defaults to HEAD)
  --to <ref>              range head
  --commit <sha>          review a single commit
  --mode <auto|ocr|delegate>   force a backend (default: auto)
  --agent <name>          force an agent CLI for delegation
                          (opencode|claude|codex|cursor-agent)
  -b, --background <text>  extra context for the reviewer
  -B, --background-file <path>  context from a markdown file
  --preview               list what would be reviewed; no LLM call
  --json                  print the JSON artifact instead of the summary
  --timeout <minutes>     per-review timeout (default: ${DEFAULT_TIMEOUT_MIN})
  -h, --help              this text

Exit codes: 0 reviewed/skipped, 1 review failed (advisory), 2 critical findings.
`

const main = () => {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[review] ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return EXIT_ERROR
  }
  if (parsed.help) {
    process.stdout.write(USAGE)
    return EXIT_OK
  }

  const repo = gitTopLevel()
  if (repo === null) {
    return fail('not inside a git repository')
  }

  const ocr = findBinary('ocr')
  const agent = parsed.agent ?? findAgent()
  const ocrVersion = ocr === null ? null : readOcrVersion()
  if (parsed.agent !== null && findBinary(parsed.agent) === null) {
    return fail(`--agent ${parsed.agent} is not on PATH`)
  }

  try {
    if (parsed.preview) {
      if (ocr === null) {
        return skip('--preview needs the `ocr` CLI: npm i -g @alibaba-group/open-code-review')
      }
      return runPreview({ repo, refs: parsed.refs, asJson: parsed.json, ocrVersion })
    }

    const backend = resolveBackend({ mode: parsed.mode, ocr, agent })
    if (backend.kind === 'unavailable') {
      // An explicit --mode is a request, not a preference: silently skipping it
      // would look like a passing review that never happened.
      return parsed.mode === 'auto' ? skip(backend.reason) : fail(backend.reason)
    }

    const tmp = mkdtempSync(join(tmpdir(), 'qadam-review-'))
    const started = Date.now()
    let result
    let backendName
    try {
      if (backend.kind === 'delegate') {
        backendName = `delegation(${backend.agent})`
        result = runDelegation({ repo, refs: parsed.refs, agent: backend.agent, opts: parsed, tmp })
      } else {
        result = runOcrManaged({ repo, refs: parsed.refs, opts: parsed, tmp })
        backendName = result.kind === 'no-endpoint' ? null : 'ocr-managed'
        if (result.kind === 'no-endpoint') {
          if (parsed.mode === 'ocr') {
            return fail('--mode ocr but no LLM endpoint is configured (run `ocr config provider`)')
          }
          if (agent === null) {
            return skip(
              'OCR has no LLM endpoint configured. Run `ocr config provider`, or install an agent CLI (opencode, claude, codex, cursor-agent) for delegation mode.'
            )
          }
          process.stdout.write(
            '[review] ocr has no LLM endpoint configured — falling back to delegation via ' + agent + '\n'
          )
          backendName = `delegation(${agent})`
          result = runDelegation({ repo, refs: parsed.refs, agent, opts: parsed, tmp })
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    if (result.kind === 'error') {
      return fail(`review failed: ${result.message}`)
    }

    const envelope = buildEnvelope({
      backend: backendName,
      toolVersion: ocrVersion,
      refs: parsed.refs,
      result,
      elapsedMs: Date.now() - started,
    })

    const artifact = writeArtifact(repo, envelope)
    envelope.artifact = artifact === null ? null : relativePath(repo, artifact)

    printReport(envelope, { asJson: parsed.json })
    return envelope.counts.critical > 0 ? EXIT_CRITICAL : EXIT_OK
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

// ── backends ────────────────────────────────────────────────────────────────

const resolveBackend = ({ mode, ocr, agent }) => {
  if (mode === 'ocr') {
    return ocr === null
      ? { kind: 'unavailable', reason: '--mode ocr but `ocr` is not on PATH' }
      : { kind: 'ocr' }
  }
  if (mode === 'delegate') {
    if (ocr === null) {
      return { kind: 'unavailable', reason: '--mode delegate needs the `ocr` CLI for preview/rules' }
    }
    return agent === null
      ? { kind: 'unavailable', reason: '--mode delegate but no agent CLI found on PATH' }
      : { kind: 'delegate', agent }
  }
  return ocr === null ? { kind: 'unavailable', reason: 'ocr is not installed' } : { kind: 'ocr' }
}

const runOcrManaged = ({ repo, refs, opts, tmp }) => {
  const outFile = join(tmp, 'ocr-review.json')
  const args = [
    'review',
    '--format', 'json',
    '--audience', 'agent',
    '--output', outFile,
    '--timeout', String(opts.timeoutMin),
    ...modeArgs(refs),
    ...backgroundArgs(opts),
  ]
  // No wall-clock kill here: ocr bounds each file group itself, and a big
  // changeset legitimately runs many groups past --timeout at concurrency 8.
  const res = run('ocr', args, { cwd: repo })
  if (res.timedOut) {
    return { kind: 'error', message: `ocr review timed out after ${opts.timeoutMin} min` }
  }
  if (res.status !== 0) {
    const stderr = res.stderr ?? ''
    if (stderr.includes('no valid LLM endpoint configured')) {
      return { kind: 'no-endpoint' }
    }
    return { kind: 'error', message: firstLine(stderr) || `ocr review exited ${res.status}` }
  }
  const payload = readJsonFile(outFile)
  if (payload === null || !Array.isArray(payload.comments)) {
    return { kind: 'error', message: 'ocr review produced no parseable JSON envelope' }
  }
  const normalized = normalizeComments(payload.comments)
  return {
    kind: 'ok',
    comments: normalized.comments,
    warnings: [...warningsOf(payload.warnings), ...normalized.warnings],
    reviewed: null,
    excluded: null,
  }
}

const runDelegation = ({ repo, refs, agent, opts, tmp }) => {
  // Background goes through OCR's own `-b`/`-B` handling on the preview rather
  // than being read here: its 1 MiB / 8000-char limits and sanitization are the
  // documented behavior, and preview echoes the resolved text.
  const preview = ocrJson(
    ['delegate', 'preview', '--format', 'json', ...modeArgs(refs), ...backgroundArgs(opts)],
    repo
  )
  const background = preview.background ?? opts.background ?? ''
  const reviewable = preview.reviewable_files ?? []
  const excluded = (preview.excluded_files ?? []).map((f) => ({ path: f.path, reason: f.exclude_reason ?? '' }))
  if (reviewable.length === 0) {
    return { kind: 'ok', comments: [], warnings: [], reviewed: [], excluded, mergeBase: preview.merge_base ?? null }
  }

  const ruleByFile = collectRules(repo, reviewable.map((f) => f.path))
  const warnings = []
  const batches = []
  let current = null

  for (const file of reviewable) {
    const rule = ruleByFile.get(file.path) ?? ''
    const diff = collectDiff({ repo, refs, path: file.path, preview })
    if (diff === null || diff.trim() === '') {
      warnings.push(`no textual diff for ${file.path}; skipped`)
      continue
    }
    if (diff.length + rule.length > MAX_BATCH_CHARS) {
      warnings.push(
        `${file.path}: diff too large for delegation (${diff.length} chars); skipped — review it with OCR-managed mode or by hand`
      )
      continue
    }
    if (
      current === null ||
      current.rule !== rule ||
      current.size + diff.length + rule.length > MAX_BATCH_CHARS
    ) {
      current = { rule, files: [], size: 0 }
      batches.push(current)
    }
    current.files.push({ path: file.path, diff })
    current.size += diff.length + rule.length
  }

  const comments = []
  const reviewed = []
  for (const batch of batches) {
    const prompt = buildPrompt({ batch, background })
    const res = runAgent(agent, prompt, opts.timeoutMin)
    if (res.timedOut) {
      warnings.push(`${agent} timed out after ${opts.timeoutMin} min on ${batch.files.length} file(s)`)
      continue
    }
    if (res.status !== 0) {
      warnings.push(`${agent} exited ${res.status}: ${firstLine(res.stderr) || 'no error output'}`)
      continue
    }
    const parsed = extractFindings(res.stdout)
    if (parsed === null) {
      warnings.push(`${agent} returned no parseable ${FINDINGS_OPEN} block for ${batch.files.length} file(s)`)
      continue
    }
    const normalized = normalizeComments(parsed.comments, new Set(batch.files.map((f) => f.path)))
    comments.push(...normalized.comments)
    warnings.push(...normalized.warnings)
    // Only a batch that actually answered counts as reviewed: listing files whose
    // agent call failed would claim coverage that never happened.
    reviewed.push(...batch.files.map((f) => f.path))
  }

  return { kind: 'ok', comments, warnings, reviewed, excluded, mergeBase: preview.merge_base ?? null }
}

const runPreview = ({ repo, refs, asJson, ocrVersion }) => {
  const preview = ocrJson(['delegate', 'preview', '--format', 'json', ...modeArgs(refs)], repo)
  const paths = (preview.reviewable_files ?? []).map((f) => f.path)
  const groups = collectRuleGroups(repo, paths)

  if (asJson) {
    process.stdout.write(JSON.stringify({ preview, groups }, null, 2) + '\n')
    return EXIT_OK
  }

  process.stdout.write(
    `[review] preview: ${preview.mode} — ${preview.reviewable_count} reviewable of ${preview.total_files} changed (ocr ${ocrVersion ?? 'unknown'})\n`
  )
  for (const file of preview.reviewable_files ?? []) {
    process.stdout.write(`  review  ${file.path} [${file.status}] +${file.insertions}/-${file.deletions}\n`)
  }
  for (const file of preview.excluded_files ?? []) {
    process.stdout.write(`  skip    ${file.path} (${file.exclude_reason})\n`)
  }
  for (const group of groups) {
    process.stdout.write(
      `  rule    ${group.files.length} file(s) <- ${group.source}:${group.pattern} (${group.rule.length} chars)\n`
    )
  }
  if (preview.merge_base) {
    process.stdout.write(`  range   merge-base ${preview.merge_base} -> ${preview.to ?? 'HEAD'}\n`)
  }
  return EXIT_OK
}

// ── ocr helpers ─────────────────────────────────────────────────────────────

const collectRules = (repo, paths) => {
  const map = new Map()
  for (const group of collectRuleGroups(repo, paths)) {
    for (const file of group.files) {
      map.set(file, group.rule ?? '')
    }
  }
  return map
}

const collectRuleGroups = (repo, paths) => {
  const groups = []
  for (let i = 0; i < paths.length; i += DELEGATE_RULE_CHUNK) {
    const chunk = paths.slice(i, i + DELEGATE_RULE_CHUNK)
    const payload = ocrJson(['delegate', 'rule', '--format', 'json', ...chunk], repo)
    groups.push(...(payload.groups ?? []))
  }
  return groups
}

const ocrJson = (args, repo) => {
  const res = run('ocr', args, { cwd: repo })
  if (res.status !== 0) {
    throw new Error(`ocr ${args.slice(0, 2).join(' ')} failed: ${firstLine(res.stderr) || `exit ${res.status}`}`)
  }
  const payload = parseJson(res.stdout)
  if (payload === null) {
    throw new Error(`ocr ${args.slice(0, 2).join(' ')} returned no parseable JSON`)
  }
  return payload
}

const readOcrVersion = () => {
  const res = run('ocr', ['--version'], {})
  return res.status === 0 ? firstLine(res.stdout) : null
}

// ── diffs and prompts ───────────────────────────────────────────────────────

const collectDiff = ({ repo, refs, path, preview }) => {
  if (refs.commit !== null) {
    return gitOrNull(repo, ['show', '--format=', '--patch', refs.commit, '--', path])
  }
  if (refs.from !== null) {
    const base = preview.merge_base || refs.from
    return gitOrNull(repo, ['diff', `${base}..${refs.to ?? 'HEAD'}`, '--', path])
  }
  const tracked = gitOrNull(repo, ['diff', 'HEAD', '--', path])
  if (tracked !== null && tracked.trim() !== '') {
    return tracked
  }
  // Workspace mode: `git diff HEAD` is empty for an untracked file, and the
  // whole file is the addition.
  const full = join(repo, path)
  if (existsSync(full)) {
    try {
      const content = readFileSync(full, 'utf8')
      return `--- /dev/null\n+++ b/${path}\n` + content.split('\n').map((line) => `+${line}`).join('\n')
    } catch {
      return null
    }
  }
  return tracked
}

const buildPrompt = ({ batch, background }) => {
  const sections = [
    'You are a strict senior code reviewer. Review ONLY the changed files below against the project rules.',
    'Report defects you can justify from the diff itself. Skip style nits, speculation and praise.',
    '',
    'Severity scale:',
    '- critical: data loss, cross-tenant leak, security hole, or a broken production path',
    '- high: a real bug or security weakness',
    '- medium: a performance, error-handling or maintainability gap',
    '- low: a minor but concrete suggestion',
    '',
    'Project rules for this batch:',
    batch.rule.trim() || '(no project-specific rule; apply the language rules you already know)',
    '',
  ]
  if (background) {
    sections.push('Context for this change:', background.trim(), '')
  }
  sections.push('Changed files (unified diffs, new-file line numbers on the + side):', '')
  for (const file of batch.files) {
    sections.push(`### ${file.path}`, '```diff', file.diff.replace(/\n+$/, ''), '```', '')
  }
  sections.push(
    'Output contract: after your analysis, print exactly one JSON object wrapped in the markers below,',
    'and nothing after the closing marker:',
    FINDINGS_OPEN,
    '{"comments":[{"path":"<one of the paths above>","content":"<the defect and the fix>","severity":"critical|high|medium|low","category":"bug|security|performance|maintainability|test|style|documentation|other","start_line":<number>,"end_line":<number>}]}',
    FINDINGS_CLOSE,
    'If a file has no findings, omit it. If there are no findings at all, print {"comments":[]} between the markers.'
  )
  return sections.join('\n')
}

const runAgent = (agent, prompt, timeoutMin) => {
  const adapter = AGENT_ADAPTERS.find((candidate) => candidate.name === agent)
  const res = run(agent, adapter.args(prompt), {
    timeoutMs: timeoutMin * 60_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.timedOut,
  }
}

const extractFindings = (rawStdout) => {
  const text = stripAnsi(rawStdout)
  const open = text.lastIndexOf(FINDINGS_OPEN)
  const close = open === -1 ? -1 : text.indexOf(FINDINGS_CLOSE, open)
  const candidate =
    open !== -1 && close !== -1
      ? text.slice(open + FINDINGS_OPEN.length, close)
      : lastJsonObject(text, '"comments"')
  if (candidate === null) {
    return null
  }
  const parsed = parseJson(stripCodeFence(candidate).trim())
  return parsed !== null && Array.isArray(parsed.comments) ? parsed : null
}

const lastJsonObject = (text, needle) => {
  let from = text.length
  while (from > 0) {
    const at = text.lastIndexOf(needle, from)
    if (at === -1) {
      return null
    }
    const start = text.lastIndexOf('{', at)
    if (start === -1) {
      return null
    }
    const end = findJsonEnd(text, start)
    if (end !== -1) {
      return text.slice(start, end)
    }
    from = at - 1
  }
  return null
}

const findJsonEnd = (text, start) => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return -1
}

// ── findings, report, artifact ──────────────────────────────────────────────

const normalizeComments = (rawComments, allowedPaths = null) => {
  const comments = []
  const warnings = []
  for (const raw of rawComments ?? []) {
    if (raw === null || typeof raw !== 'object') {
      continue
    }
    const path = typeof raw.path === 'string' ? raw.path : ''
    const content = typeof raw.content === 'string' ? raw.content.trim() : ''
    if (path === '' || content === '') {
      warnings.push('dropped a finding without a path or content')
      continue
    }
    if (allowedPaths !== null && !allowedPaths.has(path)) {
      warnings.push(`dropped a finding for a path outside the batch: ${path}`)
      continue
    }
    comments.push({
      path,
      content: stripControlChars(content),
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'unknown',
      category: typeof raw.category === 'string' ? raw.category : '',
      start_line: Number.isInteger(raw.start_line) ? raw.start_line : null,
      end_line: Number.isInteger(raw.end_line) ? raw.end_line : null,
      existing_code: typeof raw.existing_code === 'string' ? raw.existing_code : null,
      suggestion_code: typeof raw.suggestion_code === 'string' ? raw.suggestion_code : null,
    })
  }
  return { comments, warnings }
}

const warningsOf = (rawWarnings) =>
  (rawWarnings ?? []).map((warning) => {
    if (typeof warning === 'string') {
      return warning
    }
    const file = warning?.file ? `${warning.file}: ` : ''
    return `${file}${warning?.message ?? warning?.type ?? 'review warning'}`
  })

const buildEnvelope = ({ backend, toolVersion, refs, result, elapsedMs }) => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const comment of result.comments) {
    counts[comment.severity] += 1
  }
  counts.total = result.comments.length
  return {
    schema: 1,
    tool: 'qadam-flow/review',
    generated_at: new Date().toISOString(),
    backend,
    tool_version: toolVersion,
    mode: refs.commit !== null ? 'commit' : refs.from !== null ? 'range' : 'workspace',
    target: { from: refs.from, to: refs.to, commit: refs.commit, merge_base: result.mergeBase ?? null },
    reviewed_files: result.reviewed,
    excluded_files: result.excluded,
    counts,
    warnings: result.warnings,
    comments: result.comments,
    elapsed_ms: elapsedMs,
  }
}

const writeArtifact = (repo, envelope) => {
  const gitPath = gitOrNull(repo, ['rev-parse', '--git-path', 'qadam-review/last.json'])
  if (gitPath === null || gitPath.trim() === '') {
    return null
  }
  const target = isAbsolute(gitPath) ? gitPath : resolve(repo, gitPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n')
  return target
}

const printReport = (envelope, { asJson }) => {
  if (asJson) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
    return
  }
  const out = []
  const range =
    envelope.mode === 'commit'
      ? `commit ${envelope.target.commit}`
      : envelope.mode === 'range'
        ? `range ${envelope.target.from}..${envelope.target.to ?? 'HEAD'}`
        : 'working tree'
  out.push(`[review] backend: ${envelope.backend} (ocr ${envelope.tool_version ?? 'unknown'})`)
  out.push(`[review] target: ${range}`)
  if (envelope.reviewed_files !== null) {
    out.push(
      `[review] files: ${envelope.reviewed_files.length} reviewed, ${(envelope.excluded_files ?? []).length} excluded`
    )
  }
  for (const comment of envelope.comments) {
    const line = comment.start_line === null ? comment.path : `${comment.path}:${comment.start_line}`
    out.push('', `${comment.severity.toUpperCase()}  ${line}`, ...wrap(comment.content, 96, '  '))
  }
  out.push('')
  const summary = ['critical', 'high', 'medium', 'low', 'unknown']
    .map((severity) => `${envelope.counts[severity]} ${severity}`)
    .join(', ')
  out.push(`[review] findings: ${summary}`)
  for (const warning of envelope.warnings) {
    out.push(`[review] warning: ${warning}`)
  }
  out.push(`[review] artifact: ${envelope.artifact ?? 'not written'}`)
  process.stdout.write(out.join('\n') + '\n')
}

const wrap = (text, width, indent) => {
  const lines = []
  for (const paragraph of text.split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/)) {
      if (current === '') {
        current = word
      } else if (current.length + 1 + word.length <= width) {
        current += ` ${word}`
      } else {
        lines.push(indent + current)
        current = word
      }
    }
    lines.push(indent + current)
  }
  return lines
}

// ── plumbing ────────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  const parsed = {
    refs: { from: null, to: null, commit: null },
    mode: 'auto',
    agent: null,
    background: null,
    backgroundFile: null,
    preview: false,
    json: false,
    timeoutMin: DEFAULT_TIMEOUT_MIN,
    help: false,
  }
  const readValue = (index, flag) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--from':
        parsed.refs.from = readValue(i, arg)
        i += 1
        break
      case '--to':
        parsed.refs.to = readValue(i, arg)
        i += 1
        break
      case '--commit':
      case '-c':
        parsed.refs.commit = readValue(i, arg)
        i += 1
        break
      case '--mode': {
        const value = readValue(i, arg)
        if (!['auto', 'ocr', 'delegate'].includes(value)) {
          throw new Error(`--mode must be auto, ocr or delegate (got ${value})`)
        }
        parsed.mode = value
        i += 1
        break
      }
      case '--agent': {
        const value = readValue(i, arg)
        if (!AGENT_ADAPTERS.some((adapter) => adapter.name === value)) {
          throw new Error(`--agent must be one of ${AGENT_ADAPTERS.map((a) => a.name).join(', ')}`)
        }
        parsed.agent = value
        i += 1
        break
      }
      case '-b':
      case '--background':
        parsed.background = readValue(i, arg)
        i += 1
        break
      case '-B':
      case '--background-file':
        parsed.backgroundFile = readValue(i, arg)
        i += 1
        break
      case '--preview':
        parsed.preview = true
        break
      case '--json':
        parsed.json = true
        break
      case '--timeout': {
        const value = Number(readValue(i, arg))
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error('--timeout must be a positive number of minutes')
        }
        parsed.timeoutMin = value
        i += 1
        break
      }
      case '-h':
      case '--help':
        parsed.help = true
        break
      default:
        throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (parsed.refs.commit !== null && parsed.refs.from !== null) {
    throw new Error('--commit and --from/--to are mutually exclusive')
  }
  if (parsed.refs.commit !== null && parsed.refs.to !== null) {
    throw new Error('--to cannot be combined with --commit')
  }
  if (parsed.refs.to !== null && parsed.refs.from === null) {
    throw new Error('--to requires --from')
  }
  if (parsed.refs.from !== null && parsed.refs.to === null) {
    parsed.refs.to = 'HEAD'
  }
  if (parsed.backgroundFile !== null && !existsSync(parsed.backgroundFile)) {
    throw new Error(`--background-file not found: ${parsed.backgroundFile}`)
  }
  return parsed
}

const modeArgs = ({ from, to, commit }) => {
  if (commit !== null) {
    return ['--commit', commit]
  }
  if (from !== null) {
    return ['--from', from, '--to', to ?? 'HEAD']
  }
  return []
}

const backgroundArgs = ({ background, backgroundFile }) => {
  const args = []
  if (backgroundFile !== null) {
    args.push('-B', backgroundFile)
  }
  if (background !== null) {
    args.push('-b', background)
  }
  return args
}

const run = (cmd, args, { cwd, timeoutMs = 0, env } = {}) => {
  const res = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_AGENT_BUFFER,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.error?.code === 'ETIMEDOUT',
  }
}

const gitTopLevel = () => {
  const res = run('git', ['rev-parse', '--show-toplevel'], {})
  return res.status === 0 ? res.stdout.trim() : null
}

const gitOrNull = (repo, args) => {
  const res = run('git', ['-C', repo, ...args], {})
  return res.status === 0 ? res.stdout.trim() : null
}

const findAgent = () => {
  const found = AGENT_ADAPTERS.find((adapter) => findBinary(adapter.name) !== null)
  return found?.name ?? null
}

const findBinary = (name) => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') {
      continue
    }
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const readJsonFile = (path) => {
  try {
    return parseJson(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

// Model output is untrusted text headed for a terminal; ANSI CSI alone does not
// cover bare control bytes that could rewrite the line the user reads.
const stripControlChars = (text) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

const stripCodeFence = (text) => text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')

const firstLine = (text) => (text ?? '').trim().split('\n')[0]?.trim() ?? ''

const relativePath = (repo, path) => path.startsWith(repo) ? path.slice(repo.length + 1) : path

const skip = (reason) => {
  process.stdout.write(
    `[review] skipped — ${reason}\n[review] advisory only: install/set up the reviewer when convenient; the push is not affected.\n`
  )
  return EXIT_OK
}

const fail = (message) => {
  process.stderr.write(`[review] ${message}\n`)
  return EXIT_ERROR
}

// exitCode rather than process.exit(): stdout to a pipe is asynchronous, and an
// immediate exit truncates a large findings report before it is flushed.
process.exitCode = main()
