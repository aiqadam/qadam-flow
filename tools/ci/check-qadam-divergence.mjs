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
// pending changeset, 2 UNKNOWN.
//
// Tested by tools/ci/test-qadam-divergence.sh.
import fs from 'node:fs'
import { isZeroX, listQadams, measureQadams, readCommonOptions, readPendingReleases } from './qadam-divergence.mjs'

const TITLE = 'Qadam divergence (ADR-0004 gate 9)'
const MAX_ANNOTATIONS = 10

const main = async () => {
  const argv = process.argv.slice(2)
  const required = argv.includes('--required')
  const common = readCommonOptions({ argv })
  if (common.error) {
    console.error(`[check-qadam-divergence] UNKNOWN — ${common.error}.`)
    process.exitCode = 2
    return
  }
  const { root, registry, concurrency, declarations, maxAttempts, retryBaseMs } = common.options

  const qadams = listQadams({ root }).filter(isZeroX)
  if (qadams.length === 0) {
    const message = `no 0.x qadams under packages/qadams/{core,community} in ${root}, so nothing was measured`
    return finish({ required, unknown: true, lines: [`UNKNOWN — ${message}.`], annotations: [{ level: required ? 'error' : 'warning', message }] })
  }
  const results = await measureQadams({ qadams, registry, concurrency, declarations, maxAttempts, retryBaseMs })
  const pending = readPendingReleases({ root })
  const by = (status) => results.filter((result) => result.status === status)
  const divergent = by('divergent')
  const uncovered = divergent.filter((result) => !pending.has(result.name))
  const covered = divergent.filter((result) => pending.has(result.name))
  const unknown = by('unknown')

  const lines = [
    `${results.length} 0.x qadam(s) compared with ${registry}: ${by('identical').length} identical, ${divergent.length} divergent (${uncovered.length} without a pending changeset, ${covered.length} with one), ${by('unpublished').length} not on npm, ${by('skipped').length} skipped, ${unknown.length} could not be measured.`,
  ]
  const annotations = []
  for (const result of uncovered) {
    const detail = `${result.name}@${result.version} differs from npm under the same version and has no pending changeset, so an image would run different code under a released number. Add a changeset for it (ADR-0004, #852). ${summarize({ differences: result.differences })}`
    lines.push(`  divergent, no changeset: ${result.name}@${result.version}`)
    for (const difference of result.differences) {
      lines.push(`      ${difference}`)
    }
    annotations.push({ level: required ? 'error' : 'warning', message: detail })
  }
  for (const result of unknown) {
    lines.push(`  UNKNOWN ${result.name}@${result.version}: ${result.reason}`)
    annotations.push({ level: required ? 'error' : 'warning', message: `${result.name}@${result.version} could not be compared with npm: ${result.reason}` })
  }
  for (const result of by('unpublished')) {
    lines.push(`  not on npm: ${result.name}@${result.version} (nothing to compare with, not counted)`)
  }
  if (uncovered.length === 0 && unknown.length === 0) {
    lines.push('OK — every divergent 0.x qadam (if any) has a pending changeset.')
  }
  finish({ required, unknown: unknown.length > 0, failed: uncovered.length > 0, lines, annotations, uncovered, covered, unknownResults: unknown })
}

const summarize = ({ differences }) => {
  const shown = differences.slice(0, 3).join('; ')
  return differences.length > 3 ? `${shown}; and ${differences.length - 3} more.` : `${shown}.`
}

const finish = ({ required, unknown = false, failed = false, lines, annotations = [], uncovered = [], covered = [], unknownResults = [] }) => {
  const write = required && (unknown || failed) ? console.error : console.log
  write(`[check-qadam-divergence] ${required ? 'REQUIRED' : 'ADVISORY (does not fail the pull request)'}`)
  for (const line of lines) {
    write(line)
  }
  // GitHub shows ten annotations per step and drops the rest quietly, so a long list would bury
  // itself. The last visible one says how many more there are; the full list is in the log above
  // and in the run summary.
  const shown = annotations.length > MAX_ANNOTATIONS ? annotations.slice(0, MAX_ANNOTATIONS - 1) : annotations
  for (const { level, message } of shown) {
    console.log(`::${level} title=${TITLE}::${message.replace(/\r?\n/g, ' ')}`)
  }
  if (shown.length < annotations.length) {
    console.log(`::${annotations[0].level} title=${TITLE}::and ${annotations.length - shown.length} more qadam(s) — the full list is in the log and the run summary of this job`)
  }
  writeStepSummary({ required, uncovered, covered, unknownResults })
  process.exitCode = required ? (unknown ? 2 : failed ? 1 : 0) : 0
}

// GitHub renders this file on the run's summary page; it carries the full list, where annotations
// are capped at ten per step.
const writeStepSummary = ({ required, uncovered, covered, unknownResults }) => {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) {
    return
  }
  const rows = (results) => results.map((result) => `| \`${result.name}@${result.version}\` | ${result.differences.length} | ${result.differences.slice(0, 3).map((difference) => `\`${difference}\``).join('<br>')} |`)
  const parts = [`### ${TITLE} — ${required ? 'REQUIRED' : 'ADVISORY'}`, '']
  parts.push(`${uncovered.length} divergent qadam(s) without a pending changeset, ${covered.length} with one, ${unknownResults.length} that could not be measured.`, '')
  if (uncovered.length > 0) {
    parts.push('| Qadam | Differences | First differences |', '| --- | --- | --- |', ...rows(uncovered), '')
  }
  fs.appendFileSync(file, `${parts.join('\n')}\n`)
}

main().catch((error) => {
  console.error(`[check-qadam-divergence] UNKNOWN — ${error instanceof Error ? error.stack : String(error)}`)
  console.log(`::warning title=${TITLE}::the check itself failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = process.argv.includes('--required') ? 2 : 0
})
