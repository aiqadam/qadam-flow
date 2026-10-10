// Which version, and which source, each official qadam gets in an image (ADR-0004 "Builds from
// `main` give changed packages their own prerelease versions", #851).
//
// A build from `main`, per qadam:
//
//   own pending changeset        -> built from the tree as `<next>-main.<n>`, <next> being what the
//                                   release PR would give it (the plan's level on its released version)
//   no changeset, `0.x`          -> built from the tree under its released number (the legacy npm
//                                   format is not in the archive; gate 9 checks it, ADR-0004)
//   no changeset, `>=1.0.0`      -> its released artifact from the release archive, not rebuilt
//
// When the inputs are missing a build from `main` does not fail, it builds more snapshots and warns:
//
//   no release archive           -> the `>=1.0.0` qadams without a changeset are built from the tree
//                                   as a snapshot of their next patch, the rule compute-main-version
//                                   applies to a platform with no pending changeset
//   no release plan              -> every qadam is built from the tree as a snapshot of its next patch
//
// Either way one version names one artifact, and the extra snapshots are collected like any other
// (store GC). A release build never takes those paths: it fails.
//
// `<n>` is the platform's own build counter (#798, ci.yml passes `github.run_number`), so a qadam
// snapshot, the platform version and the image of that build share one number.
//
// Nothing here decides what is a valid version: the numbers come from tools/ci/check-changesets.mjs
// (`parseReleaseVersion`, `bumpVersion`), and tools/ci/test-qadam-snapshot-plan.sh checks every
// version this produces against the one parser in `@aiqadam/shared` (`qadamVersionParser`), which this
// plain-node script cannot import.
import fs from 'node:fs'
import path from 'node:path'
import { changesetGate } from '../../../ci/check-changesets.mjs'
import { isBuildCounter } from '../../../ci/compute-main-version.mjs'

export const SNAPSHOT_PLAN_FORMAT_VERSION = 1

export const SNAPSHOT_ORIGIN = {
  // Built from the tree at this build.
  TREE: 'tree',
  // Taken as-is from the release archive.
  ARCHIVE: 'archive',
}

export const SNAPSHOT_REASON = {
  OWN_CHANGESET: 'own-changeset',
  LEGACY_FROM_TREE: 'legacy-from-tree',
  RELEASED_FROM_ARCHIVE: 'released-from-archive',
  NO_ARCHIVE: 'no-archive',
  NOT_IN_ARCHIVE: 'not-in-archive',
  NO_PLAN: 'no-plan',
  RELEASE_FROM_ARCHIVE: 'release-from-archive',
  RELEASE_FROM_TREE: 'release-from-tree',
}

export const snapshotPlan = {
  // `{ ok: true, plan }`, or `{ ok: false, errors }` for what must stop a build: a release build
  // without its plan or archive, a manifest that is not a released version, a bad counter.
  compute: ({ mode, counter, packages, changePlan, archive }) => compute({ mode, counter, packages, changePlan, archive }),

  // The official qadams of a tree, the set `build-qadam-artifacts.mjs` builds.
  discover: ({ root }) => discover({ root }),

  // A plan file as the artifact builder reads it; `ok: false` names what is wrong with it.
  parse: ({ text }) => parse({ text }),
}

const OFFICIAL_QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
const MODES = ['main', 'release']
const SNAPSHOT_LEVELS = ['patch', 'minor', 'major']

const compute = ({ mode, counter, packages, changePlan, archive }) => {
  if (!MODES.includes(mode)) {
    return { ok: false, errors: [`unknown mode '${mode}', expected main or release`] }
  }
  const releaseMode = mode === 'release'
  if (releaseMode && (!changePlan.ok || !archive.available)) {
    return { ok: false, errors: releaseRefusals({ changePlan, archive }) }
  }
  const problems = [
    ...(releaseMode || isBuildCounter({ counter }) ? [] : [`'${counter}' is not a build counter <n>: digits, no leading zero (ci.yml passes github.run_number)`]),
    ...packages.flatMap(({ name, version }) => (changesetGate.parseReleaseVersion({ version }) === null
      ? [`${name}: package.json holds '${version}', not an X.Y.Z release version; the tree holds the last released version (ADR-0001)`]
      : [])),
  ]
  if (problems.length > 0) {
    return { ok: false, errors: problems }
  }
  const entries = packages.map((pkg) => planPackage({ pkg, releaseMode, counter, changePlan, archive }))
  return {
    ok: true,
    plan: {
      formatVersion: SNAPSHOT_PLAN_FORMAT_VERSION,
      mode,
      counter: releaseMode ? null : counter,
      changes: changePlan.ok ? { available: true, error: null } : { available: false, error: changePlan.error },
      archive: { available: archive.available, reason: archive.reason },
      warnings: releaseMode ? [] : warningsFor({ entries, changePlan, archive }),
      packages: entries,
    },
  }
}

const planPackage = ({ pkg, releaseMode, counter, changePlan, archive }) => {
  const base = { name: pkg.name, directory: pkg.directory, released: pkg.version }
  if (releaseMode) {
    const archived = archive.find({ name: pkg.name, version: pkg.version }) !== null
    return { ...base, version: pkg.version, origin: archived ? SNAPSHOT_ORIGIN.ARCHIVE : SNAPSHOT_ORIGIN.TREE, reason: archived ? SNAPSHOT_REASON.RELEASE_FROM_ARCHIVE : SNAPSHOT_REASON.RELEASE_FROM_TREE }
  }
  if (!changePlan.ok) {
    return snapshotOf({ base, level: 'patch', counter, reason: SNAPSHOT_REASON.NO_PLAN })
  }
  const level = changePlan.levels[pkg.name]
  if (SNAPSHOT_LEVELS.includes(level)) {
    return snapshotOf({ base, level, counter, reason: SNAPSHOT_REASON.OWN_CHANGESET })
  }
  const [major] = changesetGate.parseReleaseVersion({ version: pkg.version })
  if (major === 0) {
    return { ...base, version: pkg.version, origin: SNAPSHOT_ORIGIN.TREE, reason: SNAPSHOT_REASON.LEGACY_FROM_TREE }
  }
  if (archive.find({ name: pkg.name, version: pkg.version }) !== null) {
    return { ...base, version: pkg.version, origin: SNAPSHOT_ORIGIN.ARCHIVE, reason: SNAPSHOT_REASON.RELEASED_FROM_ARCHIVE }
  }
  return snapshotOf({ base, level: 'patch', counter, reason: archive.available ? SNAPSHOT_REASON.NOT_IN_ARCHIVE : SNAPSHOT_REASON.NO_ARCHIVE })
}

const snapshotOf = ({ base, level, counter, reason }) => ({
  ...base,
  version: `${changesetGate.bumpVersion({ version: base.released, level })}-main.${counter}`,
  origin: SNAPSHOT_ORIGIN.TREE,
  reason,
  level,
})

const releaseRefusals = ({ changePlan, archive }) => [
  ...(changePlan.ok ? [] : [`a release build needs the changesets plan: ${changePlan.error}`]),
  ...(archive.available ? [] : [`a release build needs the release archive: ${archive.reason}`]),
]

const warningsFor = ({ entries, changePlan, archive }) => {
  const fromArchiveFallback = entries.filter((entry) => entry.reason === SNAPSHOT_REASON.NO_ARCHIVE || entry.reason === SNAPSHOT_REASON.NOT_IN_ARCHIVE)
  const names = fromArchiveFallback.map((entry) => entry.name).join(', ')
  const archiveProblem = archive.available ? 'the release archive lacks their released artifact' : `the release archive is unavailable (${archive.reason})`
  return [
    ...(changePlan.ok ? [] : [`the changesets release plan is unavailable (${changePlan.error}): all ${entries.length} qadams are built from the tree as next-patch snapshots (ADR-0004)`]),
    ...(changePlan.ok && fromArchiveFallback.length > 0
      ? [`${archiveProblem}: ${fromArchiveFallback.length} qadam(s) without a changeset of their own are built from the tree as next-patch snapshots instead of taken from it (ADR-0004): ${names}`]
      : []),
  ]
}

const discover = ({ root }) => {
  return OFFICIAL_QADAM_ROOTS.flatMap((qadamRoot) => {
    const parent = path.join(root, qadamRoot)
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, 'package.json')))
      .map((entry) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(parent, entry.name, 'package.json'), 'utf8'))
        return { name: manifest.name, directory: `${qadamRoot}/${entry.name}`, version: manifest.version }
      })
  }).sort((a, b) => a.name.localeCompare(b.name))
}

const parse = ({ text }) => {
  let plan
  try {
    plan = JSON.parse(text)
  }
  catch {
    return { ok: false, error: 'the plan is not JSON' }
  }
  if (plan?.formatVersion !== SNAPSHOT_PLAN_FORMAT_VERSION || !Array.isArray(plan.packages)) {
    return { ok: false, error: `the plan is not a version-${SNAPSHOT_PLAN_FORMAT_VERSION} snapshot plan` }
  }
  const origins = Object.values(SNAPSHOT_ORIGIN)
  const bad = plan.packages.find((entry) => typeof entry?.name !== 'string' || typeof entry.version !== 'string' || !origins.includes(entry.origin))
  if (bad !== undefined) {
    return { ok: false, error: `the plan has an entry that is not { name, version, origin }: ${JSON.stringify(bad)}` }
  }
  return { ok: true, plan, find: ({ name }) => plan.packages.find((entry) => entry.name === name) ?? null }
}
