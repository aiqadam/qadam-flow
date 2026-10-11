#!/usr/bin/env bash
#
# Tests for the ADR-0003 qadam artifact build (#804): tools/scripts/qadams/bundle/.
#
# Builds real qadams from this tree into a temporary store and checks the artifact contract —
# platform packages external and declared as peers, translations inside the artifact and its
# tarball, metadata.json written from a successful load, the node_modules exception, extra entry
# points, an action executed with only the platform's copies of `@aiqadam/*` and `zod` — and that
# each guard fails when its exception is taken away, that a failed build leaves no half-built version
# behind, and that a declared `node_modules` package with an unresolvable required dependency fails
# the build rather than shipping a broken install. `--pack --allow-failures` still writes the
# archive index (empty) when every build failed.
#
# Needs `bun install` and the three platform packages built:
#   npx turbo run build --filter='@aiqadam/qadams-common...'
#
#   tools/ci/test-qadam-artifacts.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
builder="${repo}/tools/scripts/qadams/bundle/build-qadam-artifacts.mjs"

pass=0
fail=0
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

ok() {
  pass=$((pass + 1))
  printf 'ok    %s\n' "$1"
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

expect_exit() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then ok "$name (exit $actual)"; else bad "$name: expected exit $expected, got $actual"; fi
}

# --- the contract, on qadams that exercise every artifact feature -----------------------------
store="${root}/store"
node "$builder" --out "$store" --qadams csv,crypto,oracle-database,text-helper --pack --concurrency 2 >"${root}/build.log" 2>&1
expect_exit "builds csv, crypto, oracle-database, text-helper" 0 $?

STORE="$store" node --input-type=module - <<'EOF'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const store = process.env.STORE
const report = JSON.parse(readFileSync(join(store, 'report.json'), 'utf8'))
const byName = Object.fromEntries(report.results.map((r) => [r.name.replace('@aiqadam/qadam-', ''), r]))
const dir = (q) => join(store, byName[q].artifactDir)
const manifest = (q) => JSON.parse(readFileSync(join(dir(q), 'package.json'), 'utf8'))
const metadata = (q) => JSON.parse(readFileSync(join(dir(q), 'metadata.json'), 'utf8'))
const tarEntries = (q) => execFileSync('tar', ['tzf', join(store, 'archive', byName[q].tarball.file)], { encoding: 'utf8' }).split('\n')
const checks = []
const check = (name, condition) => checks.push([name, Boolean(condition)])

for (const q of ['csv', 'crypto', 'oracle-database', 'text-helper']) {
  check(`${q}: status ok`, byName[q]?.status === 'ok')
  check(`${q}: framework is a peer, not bundled`, manifest(q).peerDependencies['@aiqadam/qadams-framework']?.startsWith('^'))
  check(`${q}: bundle requires the framework from outside`, readFileSync(join(dir(q), 'src', 'index.js'), 'utf8').includes('require("@aiqadam/qadams-framework")'))
  check(`${q}: metadata.json names this version`, metadata(q).name === `@aiqadam/qadam-${q}` && metadata(q).version === manifest(q).version)
  check(`${q}: format marker`, manifest(q).qadamArtifact?.formatVersion === 1)
  check(`${q}: translations in the artifact`, existsSync(join(dir(q), 'src', 'i18n')))
  check(`${q}: translations in the tarball`, tarEntries(q).some((e) => e.startsWith('package/src/i18n/')))
  check(`${q}: metadata.json in the tarball`, tarEntries(q).includes('package/metadata.json'))
}
check('csv: ru translations reach metadata.json (#606)', typeof metadata('csv').i18n?.ru === 'object')
check('csv: locale list excludes translation.json', !byName.csv.i18nLocales.includes('translation') && byName.csv.i18nLocales.includes('ru'))
check('csv: translation.json still in the artifact', existsSync(join(dir('csv'), 'src', 'i18n', 'translation.json')))
check('csv: plain bundle, no dependencies', manifest('csv').qadamArtifact.kind === 'bundle' && manifest('csv').dependencies === undefined)
check('csv: worker entry beside the bundle', existsSync(join(dir('csv'), 'src', 'excel-to-csv-worker.js')))
check('crypto: zod is a peer', manifest('crypto').peerDependencies.zod?.startsWith('^'))
check('crypto: import.meta shimmed (the prototype load failure)', !readFileSync(join(dir('crypto'), 'src', 'index.js'), 'utf8').includes('import_meta = {}'))
check('oracle-database: node_modules exception', manifest('oracle-database').qadamArtifact.kind === 'bundle-with-node-modules')
check('oracle-database: oracledb declared and bundled for npm', manifest('oracle-database').dependencies?.oracledb && manifest('oracle-database').bundleDependencies?.includes('oracledb'))
check('oracle-database: oracledb in the tarball', tarEntries('oracle-database').some((e) => e.startsWith('package/node_modules/oracledb/')))
check('oracle-database: forked runner beside the bundle', existsSync(join(dir('oracle-database'), 'src', 'oracle-runner.js')))
const archive = JSON.parse(readFileSync(join(store, 'archive', 'archive-index.json'), 'utf8'))
check('archive index: one sha512 entry per artifact', archive.artifacts.length === 4 && archive.artifacts.every((a) => a.integrity.startsWith('sha512-') && a.commit?.sha))

// Executed with only the store's platform copies resolvable, as the engine would.
const storeRequire = createRequire(join(store, 'probe.js'))
const qadamOf = (q) => Object.values(storeRequire(join(dir(q), 'src', 'index.js'))).find((x) => x?.constructor?.name === 'Qadam')
const context = (propsValue) => ({ propsValue, run: { id: 'r1' }, server: {}, executionType: 'BEGIN' })
const rows = await qadamOf('csv').getAction('convert_csv_to_json').run(context({ csv_text: 'a,b\n1,2\n', has_headers: true, delimiter_type: ',' }))
check('csv: convert_csv_to_json runs from the artifact', JSON.stringify(rows) === '[{"a":"1","b":"2"}]')
const hash = await qadamOf('crypto').getAction('hash-text').run(context({ method: 'sha256', text: 'qadam' }))
check('crypto: hash-text runs from the artifact', hash === 'd664f5c9bf34b6bac4a9e2a15de2dbd13221969f9e54a2756c56b6a84f78a7d2')
const frameworkCopies = Object.keys(storeRequire.cache).filter((k) => k.endsWith(join('qadams', 'framework', 'dist', 'src', 'index.js')))
check('one framework copy serves every artifact', frameworkCopies.length === 1)

const failed = checks.filter(([, passed]) => !passed)
checks.forEach(([name, passed]) => console.log(`${passed ? 'ok   ' : 'FAIL '} ${name}`))
process.exit(failed.length === 0 ? 0 : 1)
EOF
expect_exit "artifact contract" 0 $?

# --- each guard fires when its exception is removed ---------------------------------------------
echo '{"qadams":{}}' >"${root}/empty-config.json"
node "$builder" --out "${root}/guards" --qadams csv,oracle-database,sftp,duckdb --config "${root}/empty-config.json" >"${root}/guards.log" 2>&1
expect_exit "a qadam that needs an exception fails the build" 1 $?

GUARDS="${root}/guards" node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const results = JSON.parse(readFileSync(join(process.env.GUARDS, 'report.json'), 'utf8')).results
const status = Object.fromEntries(results.map((r) => [r.name.replace('@aiqadam/qadam-', ''), r.status]))
const expected = {
  csv: 'runtime-file-undeclared',
  'oracle-database': 'runtime-file-undeclared',
  sftp: 'native-undeclared',
  duckdb: 'native-undeclared',
}
const wrong = Object.entries(expected).filter(([q, s]) => status[q] !== s)
Object.entries(expected).forEach(([q, s]) => console.log(`${status[q] === s ? 'ok   ' : 'FAIL '} ${q}: ${status[q]} (expected ${s})`))
process.exit(wrong.length === 0 ? 0 : 1)
EOF
expect_exit "guards report the missing exception" 0 $?

# --- cleanup: a failed build leaves no directory in the store ------------------------------------
# The statuses above are reported whether or not the half-built directory was removed, so the
# cleanup `build` promises — anything short of OK leaves no `<out>/<name>/<version>` — is asserted
# on what is actually on disk. Every guard here fails through `fail()`, which is one of the two
# removal paths (the other is the `catch`, exercised just below).
#
# The scope directory must exist or the emptiness check would be vacuous: `find` on a missing path,
# and the `|| true`, both yield nothing too, so a misplaced store would read as clean.
if [ ! -d "${root}/guards/@aiqadam" ]; then
  bad "the guard builds created no ${root}/guards/@aiqadam, so the cleanup check below would be vacuous"
else
  half_built="$(find "${root}/guards/@aiqadam" -mindepth 2 -maxdepth 2 -type d)"
  if [ -z "$half_built" ]; then
    ok "a failed build leaves no artifact directory in the store"
  else
    bad "a failed build left artifact directories: $(echo "$half_built" | tr '\n' ' ')"
  fi
fi

# --- a broken install: a declared node_modules package whose required dependency is missing ------
# The artifact's `node_modules` is copied by walking each package's required `dependencies`
# (`copyNodeModulesClosure`): a required dependency that does not resolve is a broken install, not a
# skip, so the build throws, `build`'s `catch` removes the half-built artifact, and nothing is left
# behind. A fixture rather than a real qadam because no resolved tree ships a broken install.
fixture="${root}/missing-required-dep"
mkdir -p "${fixture}/qadam/src" "${fixture}/qadam/node_modules/fixture-native-dep"
# `readEmitOptions` resolves `typescript` from the qadam's own directory, as a real qadam does; the
# fixture borrows the workspace's copy so it needs no install of its own.
ln -s "${repo}/node_modules/typescript" "${fixture}/qadam/node_modules/typescript"
cat >"${fixture}/qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-fixture", "version": "0.0.1" }
EOF
cat >"${fixture}/qadam/tsconfig.lib.json" <<'EOF'
{}
EOF
cat >"${fixture}/qadam/src/index.ts" <<'EOF'
import 'fixture-native-dep'
export const fixture = true
EOF
cat >"${fixture}/qadam/node_modules/fixture-native-dep/package.json" <<'EOF'
{ "name": "fixture-native-dep", "version": "1.0.0", "dependencies": { "fixture-missing-dep": "^1.0.0" } }
EOF
cat >"${fixture}/qadam/node_modules/fixture-native-dep/index.js" <<'EOF'
module.exports = {}
EOF
# Run as a file, not from stdin, like the traversal block: the imported module is loaded by path.
cat >"${fixture}/missing-required-dep.mjs" <<'EOF'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { qadamArtifact } = await import(pathToFileURL(join(process.env.REPO, 'tools/scripts/qadams/bundle/qadam-artifact.mjs')).href)
const config = { qadams: { '@aiqadam/qadam-fixture': { nodeModules: { 'fixture-native-dep': 'test fixture standing in for a package with a missing required dependency' } } } }
const message = await qadamArtifact.build({ qadamDir: process.env.QADAM_DIR, outRoot: process.env.OUT, repoRoot: process.env.REPO, config, loadCheck: false }).then(() => null, (error) => error.message)
const refused = typeof message === 'string' && message.includes('cannot resolve fixture-missing-dep')
const parent = join(process.env.OUT, '@aiqadam', 'qadam-fixture')
// `build` mkdirs `<out>/@aiqadam/qadam-fixture/<version>` before it can throw, so the parent's
// existence proves the remove below is exercising the `catch`, not a failure that never got there.
const created = existsSync(parent)
const leftover = created ? readdirSync(parent) : []
console.log(`${refused ? 'ok   ' : 'FAIL '} a node_modules package with an unresolvable required dependency fails the build${refused ? '' : ` (${message})`}`)
console.log(`${created ? 'ok   ' : 'FAIL '} the artifact directory was created before the failure (the removal check is not vacuous)`)
console.log(`${leftover.length === 0 ? 'ok   ' : 'FAIL '} and the half-built artifact is removed (${leftover.join(', ') || 'nothing left'})`)
process.exit(refused && created && leftover.length === 0 ? 0 : 1)
EOF
REPO="$repo" QADAM_DIR="${fixture}/qadam" OUT="${fixture}/out" node "${fixture}/missing-required-dep.mjs"
expect_exit "a missing required dependency leaves no artifact" 0 $?

# --- --pack when every build fails: the archive index is still written, with no entries ---------
node "$builder" --out "${root}/pack-failures" --qadams csv --config "${root}/empty-config.json" --pack --allow-failures >"${root}/pack-failures.log" 2>&1
expect_exit "--pack --allow-failures with a failed build exits 0" 0 $?

PACK_FAILURES="${root}/pack-failures" node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const archive = JSON.parse(readFileSync(join(process.env.PACK_FAILURES, 'archive', 'archive-index.json'), 'utf8'))
console.log(`${archive.artifacts.length === 0 ? 'ok   ' : 'FAIL '} archive index written with no artifacts`)
process.exit(archive.artifacts.length === 0 ? 0 : 1)
EOF
expect_exit "empty archive index after a failed build" 0 $?

# The oracle runner declared but oracledb not: the addon must still be caught.
echo '{"qadams":{"@aiqadam/qadam-oracle-database":{"extraEntryPoints":{"src/lib/common/oracle-runner.ts":"test"}}}}' >"${root}/runner-only.json"
node "$builder" --out "${root}/runner-only" --qadams oracle-database --config "${root}/runner-only.json" --allow-failures >"${root}/runner-only.log" 2>&1
if grep -q 'native-undeclared.*oracledb' "${root}/runner-only.log"; then ok "oracledb's prebuilt addon detected"; else bad "oracledb's prebuilt addon not detected"; fi

# --- the snapshot plan (ADR-0004, #851): version written into the artifact, archive seam --------
# csv is built as a `-main.<n>` snapshot; crypto is taken from a (fake) release archive and not built.
# The plan holds the versions this tree really has as `released`: the builder refuses a plan made for
# other versions.
csv_released="$(node -p "require('${repo}/packages/qadams/core/csv/package.json').version")"
crypto_released="$(node -p "require('${repo}/packages/qadams/core/crypto/package.json').version")"
csv_snapshot="$(node -p "const [a, b, c] = '${csv_released}'.split('.'); a + '.' + b + '.' + (Number(c) + 1) + '-main.412'")"
archive="${root}/release-archive"
archived_file="aiqadam-qadam-crypto-${crypto_released}.tgz"
mkdir -p "$archive"
printf 'archived tarball' >"${archive}/${archived_file}"
ARCHIVE="$archive" ARCHIVED_FILE="$archived_file" CSV_RELEASED="$csv_released" CRYPTO_RELEASED="$crypto_released" CSV_SNAPSHOT="$csv_snapshot" node --input-type=module - <<'EOF'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { ARCHIVE: dir, ARCHIVED_FILE: file, CSV_RELEASED, CRYPTO_RELEASED, CSV_SNAPSHOT } = process.env
const integrity = `sha512-${createHash('sha512').update(readFileSync(join(dir, file))).digest('base64')}`
writeFileSync(join(dir, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts: [{ name: '@aiqadam/qadam-crypto', version: CRYPTO_RELEASED, kind: 'bundle', file, integrity, shasum: 'x', size: 16, commit: { sha: 'archived-commit', dirtyQadams: false } }] }))
const entry = ({ name, released, version, origin }) => ({ name, directory: `packages/qadams/core/${name.split('-').pop()}`, released, version, origin, reason: 'test' })
const plan = (packages) => JSON.stringify({ formatVersion: 1, mode: 'main', counter: '412', platformVersion: '1.2.0-main.412', packages })
const csv = { name: '@aiqadam/qadam-csv', released: CSV_RELEASED, version: CSV_SNAPSHOT, origin: 'tree' }
const crypto = { name: '@aiqadam/qadam-crypto', released: CRYPTO_RELEASED, version: CRYPTO_RELEASED, origin: 'archive' }
writeFileSync(join(dir, '..', 'plan.json'), plan([entry(csv), entry(crypto)]))
writeFileSync(join(dir, '..', 'plan-stale.json'), plan([entry({ ...csv, released: '9.9.9' }), entry(crypto)]))
writeFileSync(join(dir, '..', 'plan-traversal.json'), plan([entry({ ...csv, version: '../../../../tmp/qf-traversal' }), entry(crypto)]))
EOF
node "$builder" --out "${root}/snap" --qadams csv,crypto --pack --snapshot-plan "${root}/plan.json" --release-archive "$archive" >"${root}/snap.log" 2>&1
expect_exit "builds from a snapshot plan, one qadam from the archive" 0 $?

SNAP="${root}/snap" REPO="$repo" ARCHIVE="$archive" CSV_SNAPSHOT="$csv_snapshot" ARCHIVED_FILE="$archived_file" node --input-type=module - <<'EOF'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const { SNAP: snap, REPO: repo, ARCHIVE: archive, CSV_SNAPSHOT: snapshot, ARCHIVED_FILE: archivedFile } = process.env
const frameworkVersion = JSON.parse(readFileSync(join(repo, 'packages/qadams/framework/package.json'), 'utf8')).version
const dir = join(snap, '@aiqadam', 'qadam-csv', snapshot)
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const metadata = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
const report = JSON.parse(readFileSync(join(snap, 'report.json'), 'utf8'))
const byName = Object.fromEntries(report.results.map((r) => [r.name, r]))
const index = JSON.parse(readFileSync(join(snap, 'archive', 'archive-index.json'), 'utf8'))
const fixtureIndex = JSON.parse(readFileSync(join(archive, 'archive-index.json'), 'utf8'))
const archived = index.artifacts.find((a) => a.name === '@aiqadam/qadam-crypto')
const built = index.artifacts.find((a) => a.name === '@aiqadam/qadam-csv')
const checks = [
  ['csv: stored under the snapshot version', existsSync(dir)],
  ['csv: package.json carries the snapshot version', manifest.version === snapshot],
  ['csv: metadata.json carries the snapshot version', metadata.version === snapshot],
  ['csv: the framework version it was built against is recorded', manifest.qadamArtifact.builtAgainst?.framework === frameworkVersion],
  ['csv: so is the platform version of the build', manifest.qadamArtifact.builtAgainst?.platform === '1.2.0-main.412'],
  ['csv: the tarball is named for the snapshot', built?.version === snapshot && built.file.endsWith(`${snapshot}.tgz`)],
  ['crypto: not built, reported as taken from the archive', byName['@aiqadam/qadam-crypto']?.status === 'from-archive' && !existsSync(join(snap, '@aiqadam', 'qadam-crypto'))],
  ['crypto: its archived tarball is copied into the archive, byte for byte', readFileSync(join(snap, 'archive', archivedFile), 'utf8') === 'archived tarball'],
  ['crypto: listed with the integrity of the fixture index entry', archived?.integrity === fixtureIndex.artifacts[0].integrity && archived.size === 16],
  ['crypto: and the commit it was archived with', archived?.commit.sha === 'archived-commit'],
]
checks.forEach(([name, passed]) => console.log(`${passed ? 'ok   ' : 'FAIL '} ${name}`))
process.exit(checks.every(([, passed]) => passed) ? 0 : 1)
EOF
expect_exit "snapshot plan: version in package.json and metadata.json, archive seam" 0 $?

# Every refusal says why, and the message is checked: an exit code alone would also pass for any other
# reason the build can stop with.
refuses() { # <name> <expected exit> <message fragment> <builder args…>
  local name="$1" expected="$2" fragment="$3"
  shift 3
  node "$builder" "$@" >"${root}/refusal.log" 2>&1
  local actual=$?
  expect_exit "$name" "$expected" "$actual"
  if grep -q -- "$fragment" "${root}/refusal.log"; then ok "$name: says '$fragment'"; else bad "$name: output does not say '$fragment': $(tail -2 "${root}/refusal.log" | tr '\n' ' ')"; fi
}
refuses "a plan that takes a qadam from the archive needs --release-archive" 2 'pass --release-archive' \
  --out "${root}/r1" --qadams csv,crypto --pack --snapshot-plan "${root}/plan.json"
refuses "that archive is copied by --pack, so --pack --no-load-check is refused with its own reason" 2 'not --no-load-check' \
  --out "${root}/r2" --qadams crypto --pack --no-load-check --snapshot-plan "${root}/plan.json" --release-archive "$archive"
refuses "a qadam the plan does not name is refused" 2 'not in the snapshot plan: @aiqadam/qadam-sftp' \
  --out "${root}/r3" --qadams csv,sftp --snapshot-plan "${root}/plan.json" --release-archive "$archive"
refuses "a plan made for other versions of this tree is refused" 2 'made for other versions' \
  --out "${root}/r4" --qadams csv --snapshot-plan "${root}/plan-stale.json"
refuses "a plan version that is a path is refused, and nothing is removed" 2 'version is not a release or a main snapshot' \
  --out "${root}/r5" --qadams csv --snapshot-plan "${root}/plan-traversal.json"
refuses "--release-archive without a plan is refused" 2 'only applies with --snapshot-plan' \
  --out "${root}/r6" --qadams csv --release-archive "$archive"
refuses "a plan file that is not there names why" 2 'ENOENT' \
  --out "${root}/r7" --qadams csv --snapshot-plan "${root}/no-such-plan.json"
printf 'tampered' >"${archive}/${archived_file}"
refuses "an archived tarball that no longer matches its integrity fails the build" 1 'does not match the integrity' \
  --out "${root}/r8" --qadams crypto --pack --snapshot-plan "${root}/plan.json" --release-archive "$archive"
rm "${archive}/${archived_file}"
refuses "an archived tarball that is gone fails the build" 1 'the release archive has no' \
  --out "${root}/r9" --qadams crypto --pack --snapshot-plan "${root}/plan.json" --release-archive "$archive"

# Defence in depth under the plan's own check: the builder removes `<out>/<name>/<version>` before it
# rebuilds it, and both name and version come from files, so one that is a path must stop it before
# that `rm`. Four ways in: a version that climbs, a version that is `..` (which lands on a sibling
# directory of the package's own), a name that climbs, and a tree manifest (no plan involved) with them.
# Run as a file, not from stdin: the modules it imports decide whether they are the entry point from argv[1].
cat >"${root}/traversal.mjs" <<'EOF'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { qadamArtifact } = await import(join(process.env.REPO, 'tools/scripts/qadams/bundle/qadam-artifact.mjs'))
const base = process.env.TRAVERSAL
const csvDir = join(process.env.REPO, 'packages/qadams/core/csv')
// What each case could delete if the guard failed.
const canary = (path) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'file'), 'keep'); return path }
const manifestDir = ({ name, version }) => {
  const dir = join(base, `manifest-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  return dir
}
const cases = [
  { label: 'a version that climbs', outRoot: join(base, 'a/out'), canary: canary(join(base, 'a/canary')), params: { qadamDir: csvDir, version: '../../../canary' } },
  { label: 'a version that is ..', outRoot: join(base, 'b/out'), canary: canary(join(base, 'b/out/@aiqadam')), params: { qadamDir: csvDir, version: '..' } },
  { label: 'a name that climbs, from a tree manifest', outRoot: join(base, 'c/out'), canary: canary(join(base, 'c/canary')), params: { qadamDir: manifestDir({ name: '../../canary', version: '0.1.0' }) } },
  { label: 'a version that is .., from a tree manifest', outRoot: join(base, 'd/out'), canary: canary(join(base, 'd/out/@aiqadam')), params: { qadamDir: manifestDir({ name: '@aiqadam/qadam-csv', version: '..' }) } },
  { label: 'a scoped name that climbs, from a tree manifest', outRoot: join(base, 'e/out'), canary: canary(join(base, 'e/canary')), params: { qadamDir: manifestDir({ name: '@../../../canary/x', version: '0.1.0' }) } },
]
let failed = false
for (const c of cases) {
  mkdirSync(c.outRoot, { recursive: true })
  const message = await qadamArtifact.build({ outRoot: c.outRoot, repoRoot: process.env.REPO, config: { qadams: {} }, loadCheck: false, ...c.params }).then(() => null, (error) => error.message)
  const rejected = typeof message === 'string' && /can name a directory|not a directory name/.test(message)
  const kept = existsSync(join(c.canary, 'file'))
  console.log(`${rejected ? 'ok   ' : 'FAIL '} ${c.label}: rejected before anything is removed${rejected ? '' : ` (${message})`}`)
  console.log(`${kept ? 'ok   ' : 'FAIL '} ${c.label}: the directory it pointed at is untouched`)
  failed = failed || !rejected || !kept
}
process.exit(failed ? 1 : 0)
EOF
TRAVERSAL="${root}/traversal" REPO="$repo" node "${root}/traversal.mjs"
expect_exit "a name or version that is a path never reaches the rm" 0 $?

node "$builder" --out "${repo}/.qadam-artifacts-test" --qadams csv >"${root}/inside.log" 2>&1
expect_exit "--out inside the repository is refused" 2 $?

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
