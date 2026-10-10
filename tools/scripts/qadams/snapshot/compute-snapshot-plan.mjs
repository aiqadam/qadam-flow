#!/usr/bin/env node
//
// Computes the snapshot plan of a build: which version and which source (the tree or the release
// archive) every official qadam gets (ADR-0004, #851). The rules are in snapshot-plan.mjs.
//
//   node tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs --counter <n> [--archive <dir>] [--platform-version <v>] [--out <file>] [--root <dir>]
//   node tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs --mode release --archive <dir> [--out <file>] [--root <dir>]
//
//   --counter <n>           the build counter, the `<n>` of `-main.<n>` (ci.yml passes github.run_number)
//   --archive <dir>         the release archive: what `build-qadam-artifacts.mjs --pack` wrote (#804).
//                           Left out, the archive is unavailable, which is what every build is until
//                           the release pipeline archives (#804's remaining work).
//   --platform-version <v>  the platform version of the same build, recorded in the plan so the
//                           artifact builder can record what each snapshot was built against
//   --out <file>            where the plan goes (default: stdout)
//   --mode main|release     default main. A release build fails without its plan or archive.
//
// A build from `main` never fails for a missing plan or archive: it logs a warning per fallback and
// the plan holds more snapshots. In GitHub Actions each warning is also an `::warning::` annotation.
//
// Exit: 0 plan written, 1 a release build refused, 2 unusable input (arguments, an unreadable tree).
//
// Node builtins only, so the `platform-version` job runs it without an install. Tested by
// tools/ci/test-qadam-snapshot-plan.sh.
import fs from 'node:fs'
import path from 'node:path'
import { changesetPlan } from '../../../ci/changeset-plan.mjs'
import { releaseArchive } from './release-archive.mjs'
import { snapshotPlan } from './snapshot-plan.mjs'

const main = () => {
  const args = parseArgs({ argv: process.argv.slice(2) })
  if (args.error) {
    console.error(`[qadam-snapshot-plan] ${args.error}`)
    process.exitCode = 2
    return
  }
  const result = snapshotPlan.compute({
    mode: args.mode,
    counter: args.counter,
    packages: snapshotPlan.discover({ root: args.root }),
    changePlan: changesetPlan.read({ root: args.root }),
    archive: args.archive === undefined
      ? releaseArchive.unavailable({ reason: 'no release archive is configured (--archive)' })
      : releaseArchive.fromDirectory({ dir: args.archive }),
  })
  if (!result.ok) {
    result.errors.forEach((error) => console.error(`[qadam-snapshot-plan] ${args.mode === 'release' ? 'REFUSED' : 'UNKNOWN'} — ${error}`))
    process.exitCode = args.mode === 'release' ? 1 : 2
    return
  }
  const plan = { ...result.plan, platformVersion: args.platformVersion ?? null }
  result.plan.warnings.forEach((warning) => warn({ message: warning }))
  const text = `${JSON.stringify(plan, null, 2)}\n`
  if (args.out === undefined) {
    process.stdout.write(text)
  }
  else {
    fs.writeFileSync(args.out, text)
  }
  console.error(`[qadam-snapshot-plan] ${summarize({ plan })}`)
}

const summarize = ({ plan }) => {
  const count = (origin) => plan.packages.filter((entry) => entry.origin === origin).length
  const snapshots = plan.packages.filter((entry) => entry.version !== entry.released).length
  return `${plan.packages.length} qadams: ${snapshots} snapshots, ${plan.packages.length - snapshots} at their released version (${count('tree')} built from the tree, ${count('archive')} from the release archive)`
}

const warn = ({ message }) => {
  console.error(`[qadam-snapshot-plan] WARNING — ${message}`)
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::warning title=Qadam snapshot plan::${message}`)
  }
}

const parseArgs = ({ argv }) => {
  const known = new Set(['--counter', '--archive', '--platform-version', '--out', '--mode', '--root'])
  const unknown = argv.filter((arg) => arg.startsWith('--') && !known.has(arg))
  if (unknown.length > 0) {
    return { error: `unknown argument(s): ${unknown.join(' ')}` }
  }
  const values = Object.fromEntries([...known].map((flag) => [flag, valueOf({ argv, flag })]))
  const missing = [...known].find((flag) => values[flag].present && values[flag].value === undefined)
  if (missing !== undefined) {
    return { error: `${missing} needs an argument` }
  }
  const mode = values['--mode'].value ?? 'main'
  return {
    mode,
    counter: values['--counter'].value,
    archive: values['--archive'].value === undefined ? undefined : path.resolve(values['--archive'].value),
    platformVersion: values['--platform-version'].value,
    out: values['--out'].value,
    root: values['--root'].value === undefined ? process.cwd() : path.resolve(values['--root'].value),
  }
}

const valueOf = ({ argv, flag }) => {
  const index = argv.indexOf(flag)
  if (index === -1) {
    return { present: false, value: undefined }
  }
  const value = argv[index + 1]
  return { present: true, value: value === undefined || value.startsWith('--') ? undefined : value }
}

main()
