#!/usr/bin/env bash
#
# Fixture tests for ADR-0001 gate 3 — tools/scripts/utils/package-pre-publish-checks.ts: a version
# is never published twice, decided from the registry's VERSION LIST (not the `latest` dist-tag,
# not a diff against origin/main).
#
# A stub registry (node's http module, 127.0.0.1, random port) serves canned packuments, so the
# reject cases are real HTTP exchanges with no network. The #494 case is the one that motivated
# the rewrite: a version published under a non-`latest` tag must read as published.
#
# Needs the repo's pinned ts-node, so it runs after install in _verify.yml; invoked by absolute
# path for the reason test-publish-workspace-invariants.sh's header gives.
#
#   tools/ci/test-registry-version-gate.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
ts_node_bin="$repo_root/node_modules/.bin/ts-node"
harness="$here/registry-version-gate-harness.ts"
[ -x "$ts_node_bin" ] || { echo "registry version gate tests FAILED: $ts_node_bin not found — run bun install first." >&2; exit 1; }

tmp="$(mktemp -d)"
server_pid=''
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

pass=0
fail=0

# Routes: path -> scripted responses, consumed in order (the last one repeats). Every request is
# appended to requests.log as "<path> <accept>".
cat > "$tmp/routes.json" <<'JSON'
{
  "/@aiqadam%2fqadam-published": [{ "status": 200, "body": { "name": "@aiqadam/qadam-published", "dist-tags": { "latest": "1.2.0" }, "versions": { "1.1.0": {}, "1.2.0": {} } } }],
  "/@aiqadam%2fqadam-beta": [{ "status": 200, "body": { "name": "@aiqadam/qadam-beta", "dist-tags": { "latest": "0.135.0", "beta": "0.136.0-beta.1" }, "versions": { "0.135.0": {}, "0.136.0-beta.1": {} } } }],
  "/@aiqadam%2fqadam-new": [{ "status": 404, "body": { "error": "Not found" } }],
  "/@aiqadam%2fqadam-flaky": [{ "status": 503, "body": {} }, { "status": 200, "body": { "versions": { "2.0.0": {} } } }],
  "/@aiqadam%2fqadam-down": [{ "status": 500, "body": {} }],
  "/@aiqadam%2fqadam-forbidden": [{ "status": 403, "body": {} }],
  "/@aiqadam%2fqadam-garbage": [{ "status": 200, "body": { "name": "@aiqadam/qadam-garbage" } }],
  "/@aiqadam%2fqadam-array": [{ "status": 200, "body": { "versions": ["1.0.0"] } }]
}
JSON

cat > "$tmp/server.js" <<'JS'
const http = require('http')
const fs = require('fs')
const [routesFile, logFile, portFile] = process.argv.slice(2)
const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8'))
const served = {}
const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.url} ${req.headers.accept}\n`)
  const script = routes[req.url]
  if (!script) { res.writeHead(404); res.end('{}'); return }
  const i = Math.min(served[req.url] = (served[req.url] ?? -1) + 1, script.length - 1)
  res.writeHead(script[i].status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(script[i].body))
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)))
JS

node "$tmp/server.js" "$tmp/routes.json" "$tmp/requests.log" "$tmp/port" &
server_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/port" ] && break; sleep 0.1; done
[ -s "$tmp/port" ] || { echo 'registry version gate tests FAILED: the stub registry did not start' >&2; exit 1; }
registry="http://127.0.0.1:$(cat "$tmp/port")"

# check <label> <package-name> <version> <want-outcome-prefix>
check() {
  local label="$1" name="$2" version="$3" want="$4" dir out
  dir="$tmp/pkg-${name//[@\/]/_}-${version}"
  mkdir -p "$dir"
  printf '{ "name": "%s", "version": "%s" }\n' "$name" "$version" > "$dir/package.json"
  out="$(cd "$repo_root" && timeout 60 "$ts_node_bin" --project tools/tsconfig.tools.json "$harness" "$dir" "$registry" 2>/dev/null | tail -n 1)"
  case "$out" in
    "$want"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$label" "$want" "$out" ;;
  esac
}

echo "== already published -> skip =="
check 'the version is in the list (and is latest)' '@aiqadam/qadam-published' '1.2.0' 'published'
check 'the version is in the list but is NOT latest' '@aiqadam/qadam-published' '1.1.0' 'published'
check 'the #494 case: published only under a non-latest dist-tag' '@aiqadam/qadam-beta' '0.136.0-beta.1' 'published'
check 'a transient 503 is retried, then the list is read' '@aiqadam/qadam-flaky' '2.0.0' 'published'

echo "== not published -> publish =="
check 'a version absent from the list' '@aiqadam/qadam-published' '1.3.0' 'unpublished'
check 'a version below latest that was never published is still unpublished (the list decides, not latest)' '@aiqadam/qadam-published' '1.0.0' 'unpublished'
check 'a package the registry has never seen (404)' '@aiqadam/qadam-new' '0.0.1' 'unpublished'

echo "== cannot tell -> error, never a guess =="
check 'a registry that keeps failing' '@aiqadam/qadam-down' '1.0.0' 'error: '
check 'a 403 is an answer, not a retry and not "unpublished"' '@aiqadam/qadam-forbidden' '1.0.0' 'error: '
check 'a 200 with no versions object' '@aiqadam/qadam-garbage' '1.0.0' 'error: '
check 'a versions value that is not an object' '@aiqadam/qadam-array' '1.0.0' 'error: '

echo "== the request itself =="
if grep -q '^/@aiqadam%2fqadam-published/latest' "$tmp/requests.log"; then
  fail=$((fail + 1)); echo 'FAIL  the check asked for the latest dist-tag'
else
  pass=$((pass + 1))
fi
if grep -q '^/@aiqadam%2fqadam-published application/vnd.npm.install-v1+json' "$tmp/requests.log"; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo 'FAIL  the check did not request the abbreviated packument'; cat "$tmp/requests.log"
fi
down_requests="$(grep -c '^/@aiqadam%2fqadam-down ' "$tmp/requests.log")"
forbidden_requests="$(grep -c '^/@aiqadam%2fqadam-forbidden ' "$tmp/requests.log")"
if [ "$down_requests" -eq 3 ] && [ "$forbidden_requests" -eq 1 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL  retry policy: want 3 attempts on 500 and 1 on 403, got ${down_requests} and ${forbidden_requests}"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
