#!/usr/bin/env bash
#
# Tests for the ADR-0003 qadam artifact build (#804): tools/scripts/qadams/bundle/.
#
# Builds real qadams from this tree into a temporary store and checks the artifact contract —
# platform packages external and declared as peers, translations inside the artifact and its
# tarball, metadata.json written from a successful load, the node_modules exception, extra entry
# points, an action executed with only the platform's copies of `@aiqadam/*` and `zod` — and that
# each guard fails when its exception is taken away.
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

# The oracle runner declared but oracledb not: the addon must still be caught.
echo '{"qadams":{"@aiqadam/qadam-oracle-database":{"extraEntryPoints":{"src/lib/common/oracle-runner.ts":"test"}}}}' >"${root}/runner-only.json"
node "$builder" --out "${root}/runner-only" --qadams oracle-database --config "${root}/runner-only.json" --allow-failures >"${root}/runner-only.log" 2>&1
if grep -q 'native-undeclared.*oracledb' "${root}/runner-only.log"; then ok "oracledb's prebuilt addon detected"; else bad "oracledb's prebuilt addon not detected"; fi

node "$builder" --out "${repo}/.qadam-artifacts-test" --qadams csv >"${root}/inside.log" 2>&1
expect_exit "--out inside the repository is refused" 2 $?

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
