#!/usr/bin/env bash
#
# Fixture tests for ADR-0004's gate 9 (#852): tools/ci/qadam-divergence.mjs (the comparison),
# tools/ci/measure-qadam-divergence.mjs (step 1, the measurement) and
# tools/ci/check-qadam-divergence.mjs (the advisory gate).
#
# Offline. A stub registry (node's http module, 127.0.0.1, random port) serves packuments and real
# gzip tarballs built with `tar`; the "tree" is a miniature repository with a built `dist/` per
# qadam. Every accept case is paired with a reject case that differs in one thing: a changed `.js`,
# a changed i18n catalogue, a file on one side only, a changed third-party dependency range; and the
# things that must NOT count (a `.d.ts` or `.map` difference, the publish's own manifest rewrite,
# a platform-chain dependency) are pinned the other way. An UNKNOWN block asserts that a registry
# that cannot answer, a tarball that fails its integrity check and an unbuilt tree fail closed.
#
# Needs `semver` from node_modules, so it runs after install.
#
#   tools/ci/test-qadam-divergence.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
measure="${here}/measure-qadam-divergence.mjs"
gate="${here}/check-qadam-divergence.mjs"

tmp="$(mktemp -d)"
server_pid=''
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0
fail=0
last_out=''
last_rc=0

# ---- the stub registry ---------------------------------------------------------------------
# GET /<name with %2f>          -> packument; `__REGISTRY__` in it is replaced with the real origin
# GET /-/<file>.tgz             -> the tarball
# routes.json overrides either: path -> scripted responses, consumed in order, the last repeats.
mkdir -p "$tmp/registry/-"
echo '{}' > "$tmp/routes.json"
cat > "$tmp/server.js" <<'JS'
const http = require('http')
const fs = require('fs')
const path = require('path')
const [dir, routesFile, logFile, portFile] = process.argv.slice(2)
const served = {}
const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.url}\n`)
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'))
  const script = routes[req.url]
  if (script) {
    const i = Math.min(served[req.url] = (served[req.url] ?? -1) + 1, script.length - 1)
    res.writeHead(script[i].status, { 'content-type': 'application/json' })
    res.end(script[i].body ?? '{}')
    return
  }
  const file = path.join(dir, req.url.startsWith('/-/') ? req.url : `${req.url}.json`)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('{"error":"not found"}'); return }
  const origin = `http://${req.headers.host}`
  if (file.endsWith('.tgz')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(fs.readFileSync(file)); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(fs.readFileSync(file, 'utf8').split('__REGISTRY__').join(origin))
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)))
JS
node "$tmp/server.js" "$tmp/registry" "$tmp/routes.json" "$tmp/requests.log" "$tmp/port" &
server_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
[ -s "$tmp/port" ] || { echo 'qadam divergence tests FAILED: the stub registry did not start' >&2; exit 1; }
registry="http://127.0.0.1:$(cat "$tmp/port")"

# ---- fixture helpers -----------------------------------------------------------------------
write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# A one-file-per-concern qadam: its built output, its i18n source, its manifest. The registry copy
# (`publish`) starts as an exact image of it plus the files and manifest fields the publish adds.
#   tree_qadam <tree> <short-name> <version> [extra package.json fields, e.g. '"private": true,']
tree_qadam() {
  local dir="$1/packages/qadams/community/$2"
  write "$dir/package.json" "{ \"name\": \"@aiqadam/qadam-$2\", ${4:-} \"version\": \"$3\", \"dependencies\": { \"@aiqadam/qadams-framework\": \"workspace:*\", \"@aiqadam/qadams-common\": \"workspace:*\", \"dayjs\": \"^1.11.9\" } }"
  write "$dir/src/index.ts" "export const $2 = 1"
  write "$dir/src/i18n/translation.json" '{ "Hello": "Hello" }'
  write "$dir/src/i18n/ru.json" '{ "Hello": "Привет" }'
  write "$dir/dist/src/index.js" "exports.q = require('./lib/action').a"
  write "$dir/dist/src/lib/action.js" "exports.a = 'run'"
  write "$dir/dist/src/index.d.ts" 'export declare const q: string;'
  write "$dir/dist/src/index.js.map" '{"version":3}'
}

# The registry copy of a qadam, as the publish would have produced it from that tree.
#   publish <short-name> <version>        -> $tmp/pkg-<short-name>/package, ready to edit, not yet served
new_package() {
  local src="$tmp/tree/packages/qadams/community/$1" pkg="$tmp/pkg-$1/package"
  rm -rf "$tmp/pkg-$1"
  mkdir -p "$pkg/src/i18n"
  cp -r "$src/dist/src/." "$pkg/src/"
  cp "$src/src/i18n/"*.json "$pkg/src/i18n/"
  write "$pkg/LICENSE" 'MIT'
  write "$pkg/NOTICE" 'notice'
  write "$pkg/README.md" '# readme'
  write "$pkg/package.json" "{ \"name\": \"@aiqadam/qadam-$1\", \"version\": \"$2\", \"main\": \"./src/index.js\", \"types\": \"./src/index.d.ts\", \"dependencies\": { \"@aiqadam/qadams-common\": \"0.17.0\", \"@aiqadam/qadams-framework\": \"0.35.0\", \"@aiqadam/shared\": \"0.155.0\", \"dayjs\": \"1.11.9\" }, \"license\": \"MIT\", \"repository\": { \"type\": \"git\", \"url\": \"https://github.com/aiqadam/qadam-flow.git\" } }"
}

# serve <short-name> <version> [integrity-override] — pack $tmp/pkg-<name> and list it on the registry
serve() {
  local name="$1" version="$2" tgz="$tmp/registry/-/$1-$2.tgz" integrity
  tar czf "$tgz" -C "$tmp/pkg-$1" package
  integrity="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
  [ -n "${3:-}" ] && integrity="$3"
  printf '{ "name": "@aiqadam/qadam-%s", "versions": { "%s": { "name": "@aiqadam/qadam-%s", "version": "%s", "dist": { "tarball": "__REGISTRY__/-/%s-%s.tgz", "integrity": "%s" } } } }\n' \
    "$name" "$version" "$name" "$version" "$name" "$version" "$integrity" > "$tmp/registry/@aiqadam%2fqadam-$name.json"
}

# A fresh tree. `published_same` serves an exact copy of every qadam given.
new_tree() {
  rm -rf "$tmp/tree" "$tmp/pkg-"* "$tmp/registry/"*.json "$tmp/registry/-/"*; echo '{}' > "$tmp/routes.json"
  mkdir -p "$tmp/tree/.changeset"
  write "$tmp/tree/package.json" '{ "name": "qadam-flow", "version": "1.1.0" }'
}

# qadam_published <short-name> <version> — a tree qadam with an identical registry copy
qadam_published() {
  tree_qadam "$tmp/tree" "$1" "$2"
  new_package "$1" "$2"
  serve "$1" "$2"
}

run() {
  last_out="$(timeout 120 node "$@" 2>&1)"
  last_rc=$?
}

ok() { pass=$((pass + 1)); }
fail_case() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; printf '        --- exit %s, output ---\n' "$last_rc"; printf '%s\n' "$last_out" | sed 's/^/        | /'; }

# expect <label> <want exit> <needle>... — against the last run; every needle must appear
expect() {
  local label="$1" want="$2"; shift 2
  [ "$last_rc" -eq "$want" ] || { fail_case "$label (want exit $want)"; return; }
  for needle in "$@"; do
    printf '%s' "$last_out" | grep -qF -- "$needle" || { fail_case "$label (missing: $needle)"; return; }
  done
  ok
}

# refuse <label> <needle> — the needle must NOT appear
refuse() {
  if printf '%s' "$last_out" | grep -qF -- "$2"; then fail_case "$1 (found: $2)"; else ok; fi
}

args=(--root "$tmp/tree" --registry "$registry" --retry-base-ms 0)

# ---- 1. what counts as a difference --------------------------------------------------------
echo "== identical: the publish's own additions are not differences =="
new_tree; qadam_published clean 0.1.0
run "$measure" "${args[@]}"
expect 'a qadam whose registry copy is the same build plus LICENSE/NOTICE/README, a .map, a rewritten manifest and a platform-chain dependency' 0 '1 0.x qadam(s) measured' 'identical to npm   1' 'DIVERGENT          0'

echo "== divergent: one change each =="
new_tree; qadam_published clean 0.1.0; qadam_published js 0.1.0
write "$tmp/pkg-js/package/src/lib/action.js" "exports.a = 'a different build'"; serve js 0.1.0
run "$measure" "${args[@]}"
expect 'a changed .js file' 0 'DIVERGENT          1' '@aiqadam/qadam-js@0.1.0' 'changed: src/lib/action.js'
refuse 'the unchanged qadam beside it is not listed' '@aiqadam/qadam-clean@'

new_tree; qadam_published i18n 0.2.0
write "$tmp/pkg-i18n/package/src/i18n/ru.json" '{ "Hello": "Здравствуйте" }'; serve i18n 0.2.0
run "$measure" "${args[@]}"
expect 'a changed i18n catalogue (the schedule@0.1.17 ru.json shape)' 0 'DIVERGENT          1' 'changed: src/i18n/ru.json'

new_tree; qadam_published added 0.1.0
write "$tmp/tree/packages/qadams/community/added/dist/src/lib/new.js" "exports.n = 1"
run "$measure" "${args[@]}"
expect 'a file only in the tree' 0 'DIVERGENT          1' 'only in the tree: src/lib/new.js'

new_tree; qadam_published removed 0.1.0
write "$tmp/pkg-removed/package/src/lib/old.js" "exports.o = 1"; serve removed 0.1.0
run "$measure" "${args[@]}"
expect 'a file only on npm' 0 'DIVERGENT          1' 'only on npm: src/lib/old.js'

new_tree; qadam_published deps 0.1.0
sed -i 's/"dayjs": "1.11.9"/"dayjs": "1.11.10"/' "$tmp/pkg-deps/package/package.json"; serve deps 0.1.0
run "$measure" "${args[@]}"
expect 'a third-party dependency at another version' 0 'DIVERGENT          1' 'dependencies.dayjs: tree 1.11.9, npm 1.11.10'

new_tree; qadam_published dep-added 0.1.0
sed -i 's/"dayjs": "1.11.9"/"dayjs": "1.11.9", "lodash": "4.17.21"/' "$tmp/pkg-dep-added/package/package.json"; serve dep-added 0.1.0
run "$measure" "${args[@]}"
expect 'a dependency only on npm' 0 'DIVERGENT          1' 'dependencies.lodash: tree none, npm 4.17.21'

echo "== not differences =="
new_tree; qadam_published types 0.1.0
write "$tmp/pkg-types/package/src/index.d.ts" 'export declare const q: number;'
write "$tmp/pkg-types/package/src/index.js.map" '{"version":3,"other":true}'; serve types 0.1.0
run "$measure" "${args[@]}"
expect 'a different .d.ts and .js.map are not compared by default' 0 'identical to npm   1' 'DIVERGENT          0'
run "$measure" "${args[@]}" --declarations
expect '--declarations compares the .d.ts files' 0 'DIVERGENT          1' 'changed: src/index.d.ts'
refuse '--declarations still ignores .map files' 'index.js.map'

new_tree; qadam_published range 0.1.0
sed -i 's/"dayjs": "1.11.9"/"dayjs": "~1.11.9"/' "$tmp/tree/packages/qadams/community/range/package.json"
run "$measure" "${args[@]}"
expect 'a ^ or ~ range in the tree is the exact version the publish writes' 0 'identical to npm   1'

new_tree; qadam_published dev 0.1.0
sed -i 's/"dayjs": "^1.11.9" }/"dayjs": "^1.11.9" }, "devDependencies": { "typescript": "5.0.0" }/' "$tmp/tree/packages/qadams/community/dev/package.json"
run "$measure" "${args[@]}"
expect 'devDependencies are not compared' 0 'identical to npm   1'

new_tree; qadam_published ws 0.1.0
sed -i 's/"dayjs": "^1.11.9" }/"dayjs": "^1.11.9", "@aiqadam\/qadam-sibling": "workspace:*" }/' "$tmp/tree/packages/qadams/community/ws/package.json"
sed -i 's/"dayjs": "1.11.9"/"dayjs": "1.11.9", "@aiqadam\/qadam-sibling": "0.2.0"/' "$tmp/pkg-ws/package/package.json"; serve ws 0.1.0
run "$measure" "${args[@]}"
expect 'a workspace:* dependency on another package is resolved by the publish and is not compared' 0 'identical to npm   1'

echo "== what is measured at all =="
new_tree; qadam_published zero 0.3.0
tree_qadam "$tmp/tree" stable 1.2.0
tree_qadam "$tmp/tree" snap 0.4.0-main.7
tree_qadam "$tmp/tree" hidden 0.1.0 '"private": true,'
run "$measure" "${args[@]}"
expect 'only 0.x, non-prerelease, non-private qadams are measured (1.x is out of scope, a prerelease and a private package are skipped)' 0 '3 0.x qadam(s) measured' 'identical to npm   1' 'skipped            2'
refuse 'a 1.x qadam is not in the measurement' 'qadam-stable'

new_tree; qadam_published a 0.1.0; qadam_published b 0.1.0
write "$tmp/pkg-b/package/src/lib/action.js" "exports.a = 'other'"; serve b 0.1.0
run "$measure" "${args[@]}" --qadams a,@aiqadam/qadam-b
expect '--qadams selects by short or full name' 0 '2 0.x qadam(s) measured'
run "$measure" "${args[@]}" --qadams a
expect '--qadams a leaves out b' 0 '1 0.x qadam(s) measured' 'DIVERGENT          0'

echo "== not on npm =="
new_tree; qadam_published pub 0.1.0; tree_qadam "$tmp/tree" brand-new 0.0.1
run "$measure" "${args[@]}"
expect 'a package the registry has never seen (404) is listed apart and not counted as divergent' 0 'not on npm         1' 'DIVERGENT          0' '@aiqadam/qadam-brand-new@0.0.1'

new_tree; tree_qadam "$tmp/tree" newer 0.2.0; new_package newer 0.1.0; serve newer 0.1.0
run "$measure" "${args[@]}"
expect 'a version the packument does not list (the release PR raised it, the publish has not run)' 0 'not on npm         1' 'DIVERGENT          0'

# ---- 2. fail closed --------------------------------------------------------------------------
echo "== UNKNOWN: cannot tell -> exit 2, never 'identical' =="
new_tree; qadam_published ok 0.1.0; qadam_published bad 0.1.0
serve bad 0.1.0 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
run "$measure" "${args[@]}"
expect 'a tarball that fails the registry'"'"'s own integrity' 2 'could not measure  1' 'does not match the registry'"'"'s integrity' 'identical to npm   1'

new_tree; qadam_published down 0.1.0
echo '{ "/@aiqadam%2fqadam-down": [{ "status": 500 }] }' > "$tmp/routes.json"
run "$measure" "${args[@]}" --max-attempts 3
expect 'a registry that keeps answering 500 (3 attempts)' 2 'could not measure  1' 'answered 500' 'attempt 3/3'
[ "$(grep -c '^/@aiqadam%2fqadam-down$' "$tmp/requests.log")" -ge 3 ] && ok || fail_case 'the 500 was retried to the attempt limit'

new_tree; qadam_published flaky 0.1.0
echo '{ "/@aiqadam%2fqadam-flaky": [{ "status": 503 }, { "status": 503 }, { "status": 200, "body": "{ \"versions\": {} }" }] }' > "$tmp/routes.json"
run "$measure" "${args[@]}"
expect 'a transient 503 is retried and the answer used (here: no such version -> not on npm)' 0 'not on npm         1' 'could not measure  0'

new_tree; qadam_published forbidden 0.1.0
echo '{ "/@aiqadam%2fqadam-forbidden": [{ "status": 403 }] }' > "$tmp/routes.json"
run "$measure" "${args[@]}"
expect 'a 403 is an answer, not a retry and not "not on npm"' 2 'could not measure  1' 'answered 403'
[ "$(grep -c '^/@aiqadam%2fqadam-forbidden$' "$tmp/requests.log")" -eq 1 ] && ok || fail_case 'a 403 was retried'

new_tree; qadam_published garbage 0.1.0
echo '{ "/@aiqadam%2fqadam-garbage": [{ "status": 200, "body": "{ \"name\": \"x\" }" }] }' > "$tmp/routes.json"
run "$measure" "${args[@]}"
expect 'a 200 without a versions object' 2 'could not measure  1' 'without a "versions" object'

new_tree; qadam_published elsewhere 0.1.0
sed -i 's#__REGISTRY__#http://127.0.0.1:1#' "$tmp/registry/@aiqadam%2fqadam-elsewhere.json"
run "$measure" "${args[@]}"
expect 'a tarball URL on another origin is not followed' 2 'could not measure  1' 'is not on the registry'

new_tree; qadam_published unbuilt 0.1.0
rm -rf "$tmp/tree/packages/qadams/community/unbuilt/dist"
run "$measure" "${args[@]}"
expect 'a tree that was not built' 2 'could not measure  1' 'no build output' 'build first'

new_tree
run "$measure" "${args[@]}"
expect 'no qadams at all' 2 'UNKNOWN' 'no 0.x qadams'
run "$measure" --root
expect 'a bare --root' 2 'UNKNOWN' '--root needs a value'
run "$measure" "${args[@]}" --concurrency 0
expect '--concurrency 0' 2 'UNKNOWN'

echo "== --json =="
new_tree; qadam_published same 0.1.0; qadam_published diff 0.1.0
write "$tmp/pkg-diff/package/src/lib/action.js" "exports.a = 'x'"; serve diff 0.1.0
write "$tmp/tree/.changeset/diff.md" $'---\n"@aiqadam/qadam-diff": patch\n---\n\nRelease it.'
run "$measure" "${args[@]}" --json
expect 'machine-readable output carries the counts, the status and the pending changeset' 0 '"measured": 2' '"divergent": 1' '"status": "divergent"' '"pendingChangeset": "patch"' '"changed: src/lib/action.js"'
run "$measure" "${args[@]}"
expect 'the text output marks a divergent qadam that already has a changeset' 0 '@aiqadam/qadam-diff@0.1.0  [pending changeset]' '1 already have a pending changeset, 0 do not'

# ---- 3. gate 9 --------------------------------------------------------------------------------
echo "== gate 9: advisory =="
new_tree; qadam_published clean 0.1.0
run "$gate" "${args[@]}"
expect 'nothing divergent: passes, and says it is advisory' 0 'ADVISORY (does not fail the pull request)' 'OK'
refuse 'no annotation when nothing is wrong' '::warning'
run "$gate" "${args[@]}" --required
expect 'nothing divergent: passes as required' 0 'REQUIRED' 'OK'

new_tree; qadam_published bad 0.1.0
write "$tmp/pkg-bad/package/src/lib/action.js" "exports.a = 'x'"; serve bad 0.1.0
run "$gate" "${args[@]}"
expect 'a divergent qadam with no changeset: a warning, exit 0' 0 'ADVISORY' '::warning title=Qadam divergence (ADR-0004 gate 9)::@aiqadam/qadam-bad@0.1.0 differs from npm' '1 without a pending changeset'
refuse 'advisory output is never an ::error' '::error'
run "$gate" "${args[@]}" --required
expect 'the same divergence with --required: exit 1' 1 'REQUIRED' '::error title=Qadam divergence (ADR-0004 gate 9)::@aiqadam/qadam-bad@0.1.0'

echo "== gate 9: pending changesets cover a divergence =="
write "$tmp/tree/.changeset/bad.md" $'---\n"@aiqadam/qadam-bad": patch\n---\n\nRelease it.'
run "$gate" "${args[@]}" --required
expect 'a patch changeset naming it: passes even as required' 0 'OK' '0 without a pending changeset, 1 with one'
write "$tmp/tree/.changeset/bad.md" $'---\n"@aiqadam/qadam-bad": none\n---\n\nNothing.'
run "$gate" "${args[@]}" --required
expect 'a changeset at level none releases nothing, so it does not cover' 1 '1 without a pending changeset'
write "$tmp/tree/.changeset/bad.md" $'---\n"@aiqadam/qadam-other": patch\n---\n\nSomething else.'
run "$gate" "${args[@]}" --required
expect 'a changeset naming another package does not cover it' 1 '1 without a pending changeset'
write "$tmp/tree/.changeset/bad.md" $'---\n"@aiqadam/qadam-bad": minor\n"@aiqadam/qadams-framework": patch\n---\n\nRelease it.'
run "$gate" "${args[@]}" --required
expect 'a minor changeset also covers it' 0 'OK'

echo "== gate 9: cannot measure =="
new_tree; qadam_published down 0.1.0
echo '{ "/@aiqadam%2fqadam-down": [{ "status": 500 }] }' > "$tmp/routes.json"
run "$gate" "${args[@]}" --max-attempts 1
expect 'advisory: an unreachable registry is a warning, exit 0, and is not reported as OK' 0 'could not be measured' '::warning title=Qadam divergence (ADR-0004 gate 9)::@aiqadam/qadam-down@0.1.0 could not be compared with npm'
refuse 'an unmeasured qadam is never reported OK' 'OK —'
run "$gate" "${args[@]}" --max-attempts 1 --required
expect 'required: the same failure is UNKNOWN, exit 2' 2 'REQUIRED' '::error title='

new_tree
run "$gate" "${args[@]}"
expect 'advisory with no qadams: says nothing was measured, exit 0' 0 'nothing was measured' '::warning'
run "$gate" "${args[@]}" --required
expect 'required with no qadams: exit 2' 2 'nothing was measured'
run "$gate" --root
expect 'a bare --root: exit 2 even when advisory' 2 'UNKNOWN' '--root needs a value'

echo "== gate 9: a long list does not bury itself =="
new_tree
for n in $(seq 1 12); do
  qadam_published "many-$n" 0.1.0
  write "$tmp/pkg-many-$n/package/src/lib/action.js" "exports.a = $n"; serve "many-$n" 0.1.0
done
run "$gate" "${args[@]}"
expect '12 findings: 9 annotations and one that says how many more' 0 '12 without a pending changeset' 'and 3 more qadam(s)'
[ "$(printf '%s\n' "$last_out" | grep -c '^::warning')" -eq 10 ] && ok || fail_case 'the annotation count is capped at ten'
[ "$(printf '%s\n' "$last_out" | grep -c '^  divergent, no changeset:')" -eq 12 ] && ok || fail_case 'the log still lists all twelve'

echo "== gate 9: step summary =="
new_tree; qadam_published bad 0.1.0
write "$tmp/pkg-bad/package/src/lib/action.js" "exports.a = 'x'"; serve bad 0.1.0
GITHUB_STEP_SUMMARY="$tmp/summary.md" run "$gate" "${args[@]}"
if grep -qF '`@aiqadam/qadam-bad@0.1.0`' "$tmp/summary.md" && grep -qF 'ADVISORY' "$tmp/summary.md"; then ok; else fail_case 'the run summary lists the divergent qadam'; fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
