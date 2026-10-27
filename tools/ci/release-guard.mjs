#!/usr/bin/env node
//
// The zero-touch publish loop's release guard (#852). The release PR is merged without a person
// (native auto-merge, enabled by .github/workflows/changesets.yml), so two properties the loop
// depends on cannot rest on a reviewer noticing them:
//
//   1. the per-day cap. npm caps publishes to the scope at roughly 26-38 per rolling 24 h, and a
//      429 fails the publish run at once by design (tools/ci/publish-packed-tarballs.sh). So the
//      loop must never version more than one batch: at most 30 distinct `@aiqadam/qadam-*` with a
//      pending release in this release PR.
//   2. the platform major. ADR-0001 keeps the LAST RELEASED version in the root package.json, and
//      the v2.0.0 milestone tags `2.0.0` only once every gate-9 divergence is gone. A pending
//      `"@aiqadam/platform": major` in the release PR would raise the root to 2.0.0 untagged,
//      ahead of that. It must be held back to the final batch.
//
// The guard answers one question: may this release PR leave? Exit 0 safe, 1 refused, 2 UNKNOWN (the
// pending changesets could not be read — the caller must refuse, never guess). UNKNOWN is not safe:
// an unreadable plan could hide either condition.
//
// It reads the same plan the rest of CI reads (tools/ci/changeset-plan.mjs over the self-contained
// check-changesets.mjs), so it needs no install and cannot drift from gate 1/2 on how a changeset
// parses. It only reads; it never edits a changeset, a version or the release PR.
//
//   node tools/ci/release-guard.mjs [--root <dir>] [--max-qadams <n>] [--json]
//
// Tested by tools/ci/test-release-guard.sh.
import fs from 'node:fs'
import path from 'node:path'
import { changesetPlan } from './changeset-plan.mjs'

const QADAM_PREFIX = '@aiqadam/qadam-'
const PLATFORM_PACKAGE = '@aiqadam/platform'
const QADAM_GROUPS = ['core', 'community', 'custom']
const DEFAULT_MAX_QADAMS = 30

const main = () => {
  const parsed = parseArgs({ argv: process.argv.slice(2) })
  if (parsed.error) {
    return unknown({ json: parsed.json, message: parsed.error })
  }
  const { root, maxQadams, json } = parsed.options

  // `names` only tells the plan reader which packages to check `.changeset/config.json`'s
  // fixed/linked groups for; a group including a qadam or the platform makes the plan unavailable
  // (the release would then raise it with the group, so its own changesets are not its plan).
  const plan = changesetPlan.read({ root, names: [...listQadamNames({ root }), PLATFORM_PACKAGE] })
  if (!plan.ok) {
    return unknown({ json, message: `the pending changesets could not be read: ${plan.error}` })
  }

  const qadams = Object.keys(plan.levels)
    .filter((name) => name.startsWith(QADAM_PREFIX) && plan.levels[name] !== 'none')
    .sort()
  const platformMajor = plan.levels[PLATFORM_PACKAGE] === 'major'
  const reasons = []
  if (qadams.length > maxQadams) {
    reasons.push(`${qadams.length} qadams have a pending release, above the ${maxQadams}-per-release cap`)
  }
  if (platformMajor) {
    reasons.push(`a pending "${PLATFORM_PACKAGE}": major changeset would raise the platform version before the milestone is complete (ADR-0001: the root holds the last released version)`)
  }

  const report = { root, maxQadams, safe: reasons.length === 0, qadams, platformMajor, reasons }
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  }
  else {
    printText({ report })
  }
  if (!report.safe) {
    process.exitCode = 1
  }
}

const printText = ({ report }) => {
  const verb = report.safe ? 'SAFE' : 'REFUSED'
  console.log(`[release-guard] ${verb} — ${report.qadams.length} qadam(s) with a pending release, platform major ${report.platformMajor ? 'pending' : 'not pending'} (cap ${report.maxQadams}).`)
  for (const reason of report.reasons) {
    console.log(`  - ${reason}`)
  }
  if (report.safe) {
    console.log('  - the release PR may leave: at most one batch, and no platform major.')
  }
}

const unknown = ({ json, message }) => {
  if (json) {
    console.log(JSON.stringify({ safe: false, unknown: true, message }, null, 2))
  }
  console.error(`[release-guard] UNKNOWN — ${message}. Refusing to treat this as safe.`)
  process.exitCode = 2
}

// The `@aiqadam/qadam-*` names under packages/qadams/, read from their manifests. Only the names
// are used (for the group check above), so a group with no qadam in it is irrelevant.
const listQadamNames = ({ root }) => {
  const names = []
  for (const group of QADAM_GROUPS) {
    const dir = path.join(root, 'packages', 'qadams', group)
    for (const entry of readDirNames({ dir })) {
      const manifest = readJson({ file: path.join(dir, entry, 'package.json') })
      if (typeof manifest?.name === 'string') {
        names.push(manifest.name)
      }
    }
  }
  return names
}

const readJson = ({ file }) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

const readDirNames = ({ dir }) => {
  try {
    return fs.readdirSync(dir)
  }
  catch {
    return []
  }
}

const parseArgs = ({ argv }) => {
  const options = { root: process.cwd(), maxQadams: DEFAULT_MAX_QADAMS, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
    }
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { error: '--root needs a directory', json: options.json }
      }
      options.root = value
      index += 1
    }
    else if (arg === '--max-qadams') {
      const value = argv[index + 1]
      if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
        return { error: '--max-qadams needs a whole number', json: options.json }
      }
      options.maxQadams = Number(value)
      index += 1
    }
    else {
      return { error: `unexpected argument '${arg}'`, json: options.json }
    }
  }
  return { options }
}

main()
