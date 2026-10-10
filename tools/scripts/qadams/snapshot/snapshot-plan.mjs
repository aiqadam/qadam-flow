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
// A release build (`mode: 'release'`) builds nothing under a number that is already released. A
// `>=1.0.0` qadam must be in the release archive, unless the caller names it in `produced`: what
// THIS release produces and archives (the release PR raised its version, so no archived artifact
// can exist yet). A qadam missing from the archive and not named there fails the plan, naming it:
// a version missing from the index, a tarball gone, an empty index and a malformed entry all look
// the same here, and none of them may end in a rebuild from git (ADR-0003 "never rebuilt", #476,
// ADR-0004 "a release build never takes this path; it fails instead"). The reverse also fails:
// naming a qadam as produced when the archive already holds that version. `0.x` qadams are the
// legacy npm format, are not archived, and are built from the tree.
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
  RELEASE_PRODUCED: 'release-produced',
}

export const snapshotPlan = {
  // `{ ok: true, plan }`, or `{ ok: false, errors }` for what must stop a build: a release build
  // without its plan or archive or with a `>=1.0.0` qadam that is in neither the archive nor
  // `produced`, a manifest that is not a released version, a bad counter.
  compute: ({ mode, counter, packages, changePlan, archive, produced = [] }) => compute({ mode, counter, packages, changePlan, archive, produced }),

  // The official qadams of a tree, the set `build-qadam-artifacts.mjs` builds: `{ ok: true, packages }`
  // or `{ ok: false, error }`. Both callers share it so they cannot disagree on what is official.
  discover: ({ root }) => discover({ root }),

  // A plan file as the artifact builder reads it; `ok: false` names what is wrong with it.
  parse: ({ text }) => parse({ text }),
}

const OFFICIAL_QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
const MODES = ['main', 'release']
const SNAPSHOT_LEVELS = ['patch', 'minor', 'major']

// The grammar of a qadam version, once: a release `x.y.z` or a snapshot `x.y.z-main.<n>`, numbers
// without a leading zero and at most nine digits. It is `QADAM_VERSION_PATTERN` of
// packages/shared/src/lib/automation/qadams/qadam-version.ts, which this plain-node script cannot
// import; tools/ci/test-qadam-snapshot-plan.sh runs both over the same inputs and fails on a difference.
const PLAN_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-main\.(0|[1-9][0-9]{0,8}))?$/

const compute = ({ mode, counter, packages, changePlan, archive, produced }) => {
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
    ...(releaseMode ? releaseProblems({ packages, archive, produced }) : produced.length > 0 ? ['--produced names what a release produces: it only applies to --mode release'] : []),
  ]
  if (problems.length > 0) {
    return { ok: false, errors: problems }
  }
  const entries = packages.map((pkg) => planPackage({ pkg, releaseMode, counter, changePlan, archive, produced }))
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

const planPackage = ({ pkg, releaseMode, counter, changePlan, archive, produced }) => {
  const base = { name: pkg.name, directory: pkg.directory, released: pkg.version }
  if (releaseMode) {
    return planReleasePackage({ base, archive, produced })
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

// Only called once `releaseProblems` found nothing, so every `>=1.0.0` qadam is archived or produced.
const planReleasePackage = ({ base, archive, produced }) => {
  const { released: version } = base
  if (archive.find({ name: base.name, version }) !== null) {
    return { ...base, version, origin: SNAPSHOT_ORIGIN.ARCHIVE, reason: SNAPSHOT_REASON.RELEASE_FROM_ARCHIVE }
  }
  return { ...base, version, origin: SNAPSHOT_ORIGIN.TREE, reason: produced.includes(base.name) ? SNAPSHOT_REASON.RELEASE_PRODUCED : SNAPSHOT_REASON.RELEASE_FROM_TREE }
}

const releaseProblems = ({ packages, archive, produced }) => {
  const names = new Set(packages.map(({ name }) => name))
  return [
    ...produced.filter((name) => !names.has(name)).map((name) => `--produced names ${name}, which is not an official qadam of this tree`),
    ...packages.flatMap(({ name, version }) => {
      const [major] = changesetGate.parseReleaseVersion({ version }) ?? [0]
      const archived = archive.find({ name, version }) !== null
      if (archived && produced.includes(name)) {
        return [`${name}@${version} is named as produced by this release but the archive already holds it: a released version is never rebuilt`]
      }
      if (major >= 1 && !archived && !produced.includes(name)) {
        return [`${name}@${version} is not in the release archive and is not named as produced by this release: a release build does not rebuild a released version from git (ADR-0003, ADR-0004)`]
      }
      return []
    }),
  ]
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
  const found = OFFICIAL_QADAM_ROOTS.map((qadamRoot) => discoverIn({ root, qadamRoot }))
  const failed = found.find((result) => !result.ok)
  if (failed !== undefined) {
    return failed
  }
  const packages = found.flatMap((result) => result.packages).sort((a, b) => a.name.localeCompare(b.name))
  if (packages.length === 0) {
    return { ok: false, error: `no official qadams under ${OFFICIAL_QADAM_ROOTS.join(' or ')} of ${root}` }
  }
  const duplicate = packages.find((pkg, index) => index > 0 && packages[index - 1].name === pkg.name)
  return duplicate === undefined ? { ok: true, packages } : { ok: false, error: `${duplicate.name} is the name of two qadam manifests` }
}

const discoverIn = ({ root, qadamRoot }) => {
  const parent = path.join(root, qadamRoot)
  let entries
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  }
  catch (error) {
    // A tree without one of the two roots (a fixture, a trimmed checkout) has no qadams there.
    return error?.code === 'ENOENT' ? { ok: true, packages: [] } : { ok: false, error: `${qadamRoot} cannot be read (${error?.code ?? error?.message})` }
  }
  const results = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, 'package.json')))
    .map((entry) => readManifest({ file: path.join(parent, entry.name, 'package.json'), directory: `${qadamRoot}/${entry.name}` }))
  const failed = results.find((result) => !result.ok)
  return failed ?? { ok: true, packages: results.map((result) => result.pkg) }
}

const readManifest = ({ file, directory }) => {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch (error) {
    return { ok: false, error: `${directory}/package.json cannot be read (${error?.code ?? error?.message})` }
  }
  if (typeof manifest?.name !== 'string' || typeof manifest.version !== 'string') {
    return { ok: false, error: `${directory}/package.json has no string name and version` }
  }
  return { ok: true, pkg: { name: manifest.name, directory, version: manifest.version } }
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
  const bad = plan.packages.find((entry) => describeEntryProblem({ entry }) !== null)
  if (bad !== undefined) {
    return { ok: false, error: `the plan has an entry that is not valid (${describeEntryProblem({ entry: bad })}): ${JSON.stringify(bad)}` }
  }
  const names = plan.packages.map((entry) => entry.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate !== undefined) {
    return { ok: false, error: `the plan names ${duplicate} twice` }
  }
  return { ok: true, plan, find: ({ name }) => plan.packages.find((entry) => entry.name === name) ?? null }
}

// The version becomes a directory name and a tarball name, so it is held to the version grammar
// here and not left to whoever wrote the file: `../../tmp/x` is not a version.
const describeEntryProblem = ({ entry }) => {
  if (typeof entry?.name !== 'string') {
    return 'no string name'
  }
  if (typeof entry.version !== 'string' || !PLAN_VERSION.test(entry.version)) {
    return 'version is not a release or a main snapshot'
  }
  if (typeof entry.released !== 'string' || changesetGate.parseReleaseVersion({ version: entry.released }) === null) {
    return 'released is not a release version'
  }
  if (!Object.values(SNAPSHOT_ORIGIN).includes(entry.origin)) {
    return 'origin is neither tree nor archive'
  }
  if (entry.origin === SNAPSHOT_ORIGIN.TREE && typeof entry.directory !== 'string') {
    return 'a tree entry has no directory'
  }
  return null
}
