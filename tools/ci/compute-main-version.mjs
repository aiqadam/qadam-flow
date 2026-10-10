#!/usr/bin/env node
//
// The platform version an image built from `main` reports (ADR-0001 "The platform version", #798):
//
//   <next>-main.<n>
//
// <next> is the version the release PR would give the platform if it were cut from this commit:
// the root package.json (the last released version) raised by the highest level any pending
// `.changeset/*.md` declares for `@aiqadam/platform`. With no pending platform changeset it is the
// next PATCH, not the root itself: the release PR would leave the platform where it is, but a
// build of `main` after release X.Y.Z carries changes merged after it, and `X.Y.Z-main.<n>` would
// order it BELOW the release it was built after. The next patch is the smallest version above X.Y.Z.
// Changesets' plan for `@aiqadam/platform` is exactly that maximum: the package is private and has
// no dependencies, so nothing cascades into it, and `.changeset/config.json` puts it in no
// `fixed`/`linked` group (checked below — a group would change the plan, and this script would have
// to follow).
//
// <n> is the build counter, passed in. ci.yml passes `github.run_number`: it increases with every
// run of the CI workflow and needs no state or registry round trip, so a later build of `main`
// always gets a larger <n> (ADR-0004 relies on that), and a re-run of the same run keeps its <n>.
// It is not dense (pull-request runs consume numbers too) and it restarts only if the workflow file
// is renamed — semver then still orders by <next> first.
//
// Semver orders `2.1.0-main.<n>` below `2.1.0` and above `2.0.0`, so a canary never claims a
// release it is not, and once `2.1.0` ships the canary is offered it as an update.
//
//   node tools/ci/compute-main-version.mjs --counter <n> [--root <dir>]   prints <next>-main.<n>
//   node tools/ci/compute-main-version.mjs --next [--root <dir>]          prints <next> alone (the
//                                                                         release a migration made
//                                                                         now ships in)
//
// Exit: 0 printed, 2 UNKNOWN (unreadable or inconsistent input — never a guessed version).
//
// Node builtins only (plus the self-contained check-changesets.mjs), so the image job runs it
// without an install. Tested by tools/ci/test-main-version.sh.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { changesetPlan } from './changeset-plan.mjs'
import { changesetGate } from './check-changesets.mjs'

const PLATFORM_PACKAGE = '@aiqadam/platform'
const PLATFORM_MANIFEST = 'packages/platform/package.json'
const CHANGESET_DIR = '.changeset'
const COUNTER = /^(0|[1-9]\d*)$/

export const isBuildCounter = ({ counter }) => COUNTER.test(counter ?? '')

const main = () => {
  const args = parseArgs({ argv: process.argv.slice(2) })
  if (args.error) {
    console.error(`[compute-main-version] UNKNOWN — ${args.error}`)
    process.exitCode = 2
    return
  }
  const result = compute({ root: args.root })
  if (result.error) {
    console.error(`[compute-main-version] UNKNOWN — ${result.error}`)
    process.exitCode = 2
    return
  }
  console.log(args.nextOnly ? result.next : `${result.next}-main.${args.counter}`)
  console.error(`[compute-main-version] last release ${result.released}, pending platform level ${result.level} -> next ${result.next}`)
}

const compute = ({ root }) => {
  const released = readJson({ file: path.join(root, 'package.json') })?.version
  if (changesetGate.parseReleaseVersion({ version: released }) === null) {
    return { error: `the root package.json version '${released}' is not an X.Y.Z release version; under ADR-0001 it holds the last released version` }
  }
  const platform = readJson({ file: path.join(root, PLATFORM_MANIFEST) })?.version
  if (platform !== released) {
    return { error: `${PLATFORM_MANIFEST} is '${platform}' but the root package.json is '${released}' — they must agree (check-changesets fails a PR that splits them)` }
  }
  const plan = changesetPlan.read({ root })
  if (!plan.ok) {
    return { error: plan.error }
  }
  const grouped = [...(plan.config.fixed ?? []), ...(plan.config.linked ?? [])].some((group) => Array.isArray(group) && group.includes(PLATFORM_PACKAGE))
  if (grouped) {
    return { error: `${CHANGESET_DIR}/config.json puts ${PLATFORM_PACKAGE} in a fixed/linked group; the release plan is then not its own changesets alone` }
  }
  const level = changesetGate.pendingLevel({ changesets: plan.changesets, name: PLATFORM_PACKAGE })
  const next = changesetGate.bumpVersion({ version: released, level: level === 'none' ? 'patch' : level })
  return { released, level, next }
}

const parseArgs = ({ argv }) => {
  const valueOf = (flag) => {
    const index = argv.indexOf(flag)
    if (index === -1) {
      return { present: false }
    }
    const value = argv[index + 1]
    return { present: true, value: value === undefined || value.startsWith('--') ? undefined : value }
  }
  const known = new Set(['--counter', '--root', '--next'])
  const unknown = argv.filter((arg) => arg.startsWith('--') && !known.has(arg))
  if (unknown.length > 0) {
    return { error: `unknown argument(s): ${unknown.join(' ')}` }
  }
  const rootArg = valueOf('--root')
  if (rootArg.present && rootArg.value === undefined) {
    return { error: '--root needs a directory argument' }
  }
  const root = rootArg.present ? path.resolve(rootArg.value) : process.cwd()
  if (argv.includes('--next')) {
    return { root, nextOnly: true }
  }
  const counter = valueOf('--counter')
  if (!counter.present || counter.value === undefined) {
    return { error: 'pass --counter <n> (ci.yml passes github.run_number) or --next' }
  }
  if (!isBuildCounter({ counter: counter.value })) {
    return { error: `--counter '${counter.value}' is not a semver numeric identifier (digits, no leading zero)` }
  }
  return { root, counter: counter.value }
}

const readJson = ({ file }) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main()
}
