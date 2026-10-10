#!/usr/bin/env node
//
// ADR-0004 gate 9 (#852): every qadam in an image is either a released artifact or a `-main.<n>`
// build. For the qadams still on `0.x` that means: the tree build matches the npm tarball of the
// same version, or the qadam has a pending changeset, which makes the next `main` build give it
// its own `-main.<n>` version instead of the released number.
//
// ADVISORY until the divergences reach zero. ADR-0004: "a measurement script first, then the gate
// runs advisory while the changesets land in batches and the releases are spread under the cap. It
// turns required when the divergences reach zero, and before `2.0.0`." Advisory means this exits 0
// on a finding (and on a failure to measure) and says so loudly: `::warning::` annotations, a step
// summary, and a first line that says ADVISORY. `--required` is the switch for the day the
// list is empty: a finding then exits 1 and a failure to measure exits 2. Wiring it as a required
// check is a separate change — that needs the always-reporting gate-job pattern
// (.agents/docs/verification-pitfalls.md), which an advisory job does not.
//
// The comparison itself — what "differs" means, what is not compared — is
// tools/ci/qadam-divergence.mjs; tools/ci/measure-qadam-divergence.mjs lists every divergence
// regardless of changesets (the number the clean-up has to drive to zero).
//
// WHAT IT KNOWS ABOUT `-main.<n>`: nothing. A `-main.<n>` version is computed at build time and
// never committed (ADR-0004), so it never appears in the tree this gate reads. "Will be a
// `-main.<n>` build" is read as "has a pending release (patch, minor or major) in `.changeset/`"
// — the rule ADR-0004 gives for a package with its own changeset. A tree version that is already a
// prerelease is skipped. The shared `x.y.z-main.<n>` parser of #850/#851 is not needed for this
// check, and nothing here depends on it; when it lands, the "released or `-main`" test for built
// artifacts (rather than the tree) can use it.
//
// WHAT IT DOES NOT CHECK
// - Bundle-format qadams (`1.0.0` and later, ADR-0003): their integrity is the catalogue's, not
//   npm's, and none exists yet (assemblyai is on 2.0.0 and is not a bundle).
// - That the pending changeset's LEVEL is right (gate 2) or that it exists for a changed qadam at
//   all (gate 1): a divergence that predates the PR needs a changeset all the same, which is the
//   point of this gate.
// - Whether the release PR then publishes the qadam in time: that is the release plan against the
//   npm cap, not a check.
//
//   node tools/ci/check-qadam-divergence.mjs [--required] [--root <dir>] [--registry <url>]
//                                            [--concurrency <n>] [--declarations]
//                                            [--max-attempts <n>] [--retry-base-ms <n>]
//
// The tree must be built first (`npx turbo run build --filter='@aiqadam/qadam-*'`). Needs `semver`
// from node_modules, so it runs after `bun install`.
//
// Exit: advisory 0 always (bad arguments 2). With --required: 0 pass, 1 divergent qadam without a
// pending changeset, 2 UNKNOWN (a qadam that could not be measured, no 0.x qadams found, a changeset
// that does not parse).
//
// Tested by tools/ci/test-qadam-divergence.sh.
import fs from 'node:fs'
import { qadamDivergence } from './qadam-divergence.mjs'

const TITLE = 'Qadam divergence (ADR-0004 gate 9)'
const MAX_ANNOTATIONS = 10

const main = async () => {
  const argv = process.argv.slice(2)
  const required = argv.includes('--required')
  const common = qadamDivergence.readCommonOptions({ argv })
  if (common.error) {
    console.error(`[check-qadam-divergence] UNKNOWN — ${common.error}.`)
    process.exitCode = 2
    return
  }
  const { root, registry, concurrency, declarations, maxAttempts, retryBaseMs } = common.options

  const qadams = qadamDivergence.listQadams({ root }).filter(qadamDivergence.isZeroX)
  if (qadams.length === 0) {
    const message = `no 0.x qadams under packages/qadams/{core,community} in ${root}, so nothing was measured`
    return finish({ required, unknown: true, headline: `UNKNOWN — ${message}.`, lines: [], annotations: [{ level: level({ required }), message }] })
  }
  const { changesets, problems } = qadamDivergence.readChangesets({ root })
  if (problems.length > 0) {
    const message = `a changeset does not parse, so which qadams it covers is unknown: ${problems.join(' | ')}`
    return finish({ required, unknown: true, headline: `UNKNOWN — ${message}.`, lines: [], annotations: [{ level: level({ required }), message }] })
  }

  const results = await qadamDivergence.measureQadams({ qadams, registry, concurrency, declarations, maxAttempts, retryBaseMs })
  const { identical, divergent, uncovered, covered, unpublished, skipped, unknown } = qadamDivergence.classify({ results, changesets })

  const lines = []
  const annotations = []
  for (const result of uncovered) {
    lines.push(`  divergent, no changeset: ${result.name}@${result.version}`)
    for (const difference of result.differences) {
      lines.push(`      ${difference}`)
    }
    annotations.push({ level: level({ required }), message: `${result.name}@${result.version} differs from npm under the same version and has no pending changeset, so an image would run different code under a released number. Add a changeset for it (ADR-0004, #852). ${summarize({ differences: result.differences })}` })
  }
  for (const result of unknown) {
    lines.push(`  UNKNOWN ${result.name}@${result.version}: ${result.reason}`)
    annotations.push({ level: level({ required }), message: `${result.name}@${result.version} could not be compared with npm: ${result.reason}` })
  }
  for (const result of unpublished) {
    lines.push(`  not on npm: ${result.name}@${result.version} (nothing to compare with, not counted)`)
  }
  if (uncovered.length === 0 && unknown.length === 0) {
    lines.push('OK — every divergent 0.x qadam (if any) has a pending changeset.')
  }
  const headline = `${results.length} 0.x qadam(s) compared with ${registry}: ${identical.length} identical, ${divergent.length} divergent (${uncovered.length} without a pending changeset, ${covered.length} with one), ${unpublished.length} not on npm, ${skipped.length} skipped, ${unknown.length} could not be measured.`
  finish({ required, unknown: unknown.length > 0, failed: uncovered.length > 0, headline, lines, annotations, uncovered, unknownResults: unknown })
}

const level = ({ required }) => (required ? 'error' : 'warning')

const summarize = ({ differences }) => {
  const shown = differences.slice(0, 3).join('; ')
  return differences.length > 3 ? `${shown}; and ${differences.length - 3} more.` : `${shown}.`
}

// The one place a workflow command is written. Everything that reaches it came, at some remove, from
// a tarball, a registry or a package.json: control characters and `::` are stripped, so no line of it
// can start another command.
const annotate = ({ level: annotationLevel, message }) => {
  console.log(`::${annotationLevel} title=${TITLE}::${qadamDivergence.sanitize({ text: message })}`)
}

const finish = ({ required, unknown = false, failed = false, headline, lines, annotations = [], uncovered = [], unknownResults = [] }) => {
  const write = required && (unknown || failed) ? console.error : console.log
  write(`[check-qadam-divergence] ${required ? 'REQUIRED' : 'ADVISORY (does not fail the pull request)'}`)
  write(headline)
  for (const line of lines) {
    write(line)
  }
  // GitHub shows ten annotations per step and drops the rest quietly, so a long list would bury
  // itself. The last visible one says how many more there are; the full list is in the log above
  // and in the run summary.
  const shown = annotations.length > MAX_ANNOTATIONS ? annotations.slice(0, MAX_ANNOTATIONS - 1) : annotations
  for (const annotation of shown) {
    annotate(annotation)
  }
  if (shown.length < annotations.length) {
    annotate({ level: annotations[0].level, message: `and ${annotations.length - shown.length} more qadam(s) — the full list is in the log and the run summary of this job` })
  }
  writeStepSummary({ required, unknown, headline, uncovered, unknownResults })
  if (!required) {
    process.exitCode = 0
    return
  }
  if (unknown) {
    process.exitCode = 2
    return
  }
  process.exitCode = failed ? 1 : 0
}

// GitHub renders this file on the run's summary page; it carries the full list, where annotations
// are capped at ten per step.
const writeStepSummary = ({ required, unknown, headline, uncovered, unknownResults }) => {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) {
    return
  }
  const cell = (text) => qadamDivergence.sanitize({ text }).replace(/[|`]/g, "'")
  const parts = [`### ${TITLE} — ${required ? 'REQUIRED' : 'ADVISORY'}`, '']
  parts.push(unknown && uncovered.length === 0 && unknownResults.length === 0 ? `**${cell(headline)}**` : cell(headline), '')
  if (uncovered.length > 0) {
    parts.push('Divergent, no pending changeset:', '', '| Qadam | Differences | First differences |', '| --- | --- | --- |')
    parts.push(...uncovered.map((result) => `| \`${cell(`${result.name}@${result.version}`)}\` | ${result.differences.length} | ${result.differences.slice(0, 3).map((difference) => `\`${cell(difference)}\``).join('<br>')} |`), '')
  }
  if (unknownResults.length > 0) {
    parts.push('Could not be measured:', '', '| Qadam | Reason |', '| --- | --- |')
    parts.push(...unknownResults.map((result) => `| \`${cell(`${result.name}@${result.version}`)}\` | ${cell(result.reason)} |`), '')
  }
  fs.appendFileSync(file, `${parts.join('\n')}\n`)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[check-qadam-divergence] UNKNOWN — ${error instanceof Error ? error.stack : String(error)}`)
  annotate({ level: 'warning', message: `the check itself failed: ${message}` })
  process.exitCode = process.argv.includes('--required') ? 2 : 0
})
