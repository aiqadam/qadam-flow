#!/usr/bin/env node
//
// Computes the snapshot plan of a build: which version and which source (the tree or the release
// archive) every official qadam gets (ADR-0004, #851). The rules are in snapshot-plan.mjs.
//
//   node tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs --counter <n> [--archive <dir>] [--platform-version <v>] [--out <file>] [--root <dir>]
//   node tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs --mode release --archive <dir> [--produced <name,...>] [--out <file>] [--root <dir>]
//
//   --counter <n>           the build counter, the `<n>` of `-main.<n>` (ci.yml passes github.run_number)
//   --archive <dir>         the release archive: what `build-qadam-artifacts.mjs --pack` wrote (#804).
//                           Left out, the archive is unavailable, which is what every build is until
//                           the release pipeline archives (#804's remaining work).
//   --platform-version <v>  the platform version of the same build, recorded in the plan so the
//                           artifact builder can record what each snapshot was built against
//   --out <file>            where the plan goes (default: stdout)
//   --mode main|release     default main. A release build fails without its plan or archive, and for
//                           a `>=1.0.0` qadam that is in neither the archive nor --produced.
//   --produced <a,b>        release mode: the package names this release produces and archives, which
//                           the release PR raised; they are built from the tree. Anything else at
//                           `>=1.0.0` must be in the archive. Nothing fills this in yet: that is
//                           #804's release wiring.
//
// A build from `main` never fails for a missing plan or archive: it logs a warning per fallback and
// the plan holds more snapshots. In GitHub Actions each warning is also an `::warning::` annotation.
//
// Exit: 0 plan written, 1 a release build refused, 2 unusable input (arguments, an unreadable tree,
// a file that cannot be written).
//
// Node builtins only, so the `platform-version` job runs it without an install. Tested by
// tools/ci/test-qadam-snapshot-plan.sh.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { changesetPlan } from '../../../ci/changeset-plan.mjs'
import { releaseArchive } from './release-archive.mjs'
import { SNAPSHOT_ORIGIN, snapshotPlan } from './snapshot-plan.mjs'

const main = () => {
  const args = readArgs({ argv: process.argv.slice(2) })
  if (args.error) {
    console.error(`[qadam-snapshot-plan] ${args.error}`)
    process.exitCode = 2
    return
  }
  const discovered = snapshotPlan.discover({ root: args.root })
  if (!discovered.ok) {
    console.error(`[qadam-snapshot-plan] UNKNOWN — ${discovered.error}`)
    process.exitCode = 2
    return
  }
  const result = snapshotPlan.compute({
    mode: args.mode,
    counter: args.counter,
    packages: discovered.packages,
    changePlan: changesetPlan.read({ root: args.root, names: discovered.packages.map((pkg) => pkg.name) }),
    archive: args.archive === undefined
      ? releaseArchive.unavailable({ reason: 'no release archive is configured (--archive)' })
      : releaseArchive.fromDirectory({ dir: args.archive }),
    produced: args.produced,
  })
  if (!result.ok) {
    result.errors.forEach((error) => console.error(`[qadam-snapshot-plan] ${args.mode === 'release' ? 'REFUSED' : 'UNKNOWN'} — ${oneLine({ text: error })}`))
    process.exitCode = args.mode === 'release' ? 1 : 2
    return
  }
  const plan = { ...result.plan, platformVersion: args.platformVersion ?? null }
  const written = write({ text: `${JSON.stringify(plan, null, 2)}\n`, out: args.out })
  if (!written.ok) {
    console.error(`[qadam-snapshot-plan] UNKNOWN — ${args.out} cannot be written (${written.reason})`)
    process.exitCode = 2
    return
  }
  result.plan.warnings.forEach((warning) => warn({ message: warning }))
  console.error(`[qadam-snapshot-plan] ${summarize({ plan })}`)
}

const write = ({ text, out }) => {
  if (out === undefined) {
    process.stdout.write(text)
    return { ok: true }
  }
  try {
    fs.writeFileSync(out, text)
    return { ok: true }
  }
  catch (error) {
    return { ok: false, reason: error?.code ?? error?.message }
  }
}

const summarize = ({ plan }) => {
  const count = (origin) => plan.packages.filter((entry) => entry.origin === origin).length
  const snapshots = plan.packages.filter((entry) => entry.version !== entry.released).length
  return `${plan.packages.length} qadams: ${snapshots} snapshots, ${plan.packages.length - snapshots} at their released version (${count(SNAPSHOT_ORIGIN.TREE)} built from the tree, ${count(SNAPSHOT_ORIGIN.ARCHIVE)} from the release archive)`
}

// A message carries file names and reasons from the tree under build, so it is data: it must not
// end a log line early and start a workflow command of its own (`::set-output`, `##[`).
const oneLine = ({ text }) => text.replace(/[\r\n]+/g, ' ').replaceAll('##[', '# #[')

const warn = ({ message }) => {
  console.error(`[qadam-snapshot-plan] WARNING — ${oneLine({ text: message })}`)
  if (process.env.GITHUB_ACTIONS === 'true') {
    const encoded = message.replaceAll('##[', '# #[').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
    console.error(`::warning title=Qadam snapshot plan::${encoded}`)
  }
}

const readArgs = ({ argv }) => {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        counter: { type: 'string' },
        archive: { type: 'string' },
        'platform-version': { type: 'string' },
        out: { type: 'string' },
        mode: { type: 'string', default: 'main' },
        root: { type: 'string' },
        produced: { type: 'string' },
      },
    }))
  }
  catch (error) {
    return { error: error.message }
  }
  if (values.mode !== 'main' && values.mode !== 'release') {
    return { error: `unknown mode '${values.mode}', expected main or release` }
  }
  return {
    mode: values.mode,
    counter: values.counter,
    archive: values.archive === undefined ? undefined : path.resolve(values.archive),
    platformVersion: values['platform-version'],
    out: values.out,
    root: values.root === undefined ? process.cwd() : path.resolve(values.root),
    produced: (values.produced ?? '').split(',').map((name) => name.trim()).filter((name) => name !== ''),
  }
}

main()
