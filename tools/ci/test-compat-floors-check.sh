#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-compat-floors.mjs — ADR-0001 gate 7 (every qadam's
# minimumSupportedRelease is at or below the platform version, maximumSupportedRelease, when set,
# is not below it). Each case is a one-qadam tree under --root; accept and reject cases differ in
# one value. Needs `typescript` and `semver` from node_modules, so it runs after install.
#
#   tools/ci/test-compat-floors-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-compat-floors.mjs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0

# tree <name> <platform-version> <createQadam config body> [framework clamp, default 0.82.0]
tree() {
  local dir="${tmp}/$1"
  mkdir -p "$dir/packages/qadams/community/demo/src" "$dir/packages/qadams/framework/src/lib/context"
  printf "export const LATEST_CONTEXT_VERSION = ContextVersion.V2;\nexport const MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION = '%s';\n" "${4:-0.82.0}" > "$dir/packages/qadams/framework/src/lib/context/versioning.ts"
  printf '{ "name": "qadam-flow", "version": "%s" }\n' "$2" > "$dir/package.json"
  printf '{ "name": "@aiqadam/qadam-demo", "version": "1.0.0" }\n' > "$dir/packages/qadams/community/demo/package.json"
  printf "import { createQadam } from '@aiqadam/qadams-framework'\nexport const demo = createQadam({\n  displayName: 'Demo',\n%s\n  actions: [],\n})\n" "$3" > "$dir/packages/qadams/community/demo/src/index.ts"
  printf '%s\n' "$dir"
}

expect() {
  local want="$1" label="$2" dir="$3" needle="${4:-}" out got
  out="$(timeout 60 node "$checker" --root "$dir" 2>&1)"
  got=$?
  if [ "$got" -ne "$want" ] || { [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF -- "$needle"; }; then
    fail=$((fail + 1))
    printf 'FAIL  %s (want %s, got %s)\n' "$label" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/        | /'
    return
  fi
  pass=$((pass + 1))
}

echo "== consistent =="
expect 0 'floor 0.0.0 under platform 2.0.0' "$(tree zero 2.0.0 "  minimumSupportedRelease: '0.0.0',")" 'OK'
expect 0 'floor equal to the platform' "$(tree equal 2.0.0 "  minimumSupportedRelease: '2.0.0',")" 'OK'
expect 0 'ceiling equal to the platform' "$(tree ceiling-equal 2.0.0 "  maximumSupportedRelease: '2.0.0',")" 'OK'
expect 0 'floor and ceiling around the platform' "$(tree both 2.0.0 "  minimumSupportedRelease: '1.0.0',
  maximumSupportedRelease: '2.9.0',")" 'OK'
expect 0 'no floor at all' "$(tree none 2.0.0 '')" 'OK'

echo "== inconsistent =="
expect 1 'floor above the platform' "$(tree floor-high 2.0.0 "  minimumSupportedRelease: '2.1.0',")" 'effective minimumSupportedRelease 2.1.0 (declared) is above the platform version 2.0.0'
expect 1 'an inherited 0.90.0 floor against a 0.x platform' "$(tree inherited 0.85.0 "  minimumSupportedRelease: '0.90.0',")" 'is above the platform version 0.85.0'
expect 1 'ceiling below the platform' "$(tree ceiling-low 2.0.0 "  maximumSupportedRelease: '1.9.9',")" 'maximumSupportedRelease 1.9.9 is below the platform version 2.0.0'
expect 1 'floor above ceiling' "$(tree inverted 1.4.5 "  minimumSupportedRelease: '1.5.0',
  maximumSupportedRelease: '1.4.0',")" 'is above maximumSupportedRelease'
expect 1 'a floor that is not semver' "$(tree not-semver 2.0.0 "  minimumSupportedRelease: 'latest',")" "'latest' is not a valid semver version"
expect 1 'a floor that is not a literal cannot be audited' "$(tree not-literal 2.0.0 "  minimumSupportedRelease: MIN_RELEASE,")" 'is not a string literal'
expect 1 'a shorthand floor cannot be audited' "$(tree shorthand 2.0.0 "  minimumSupportedRelease,")" 'is not a string literal'
expect 1 'a quoted floor key is read, not skipped' "$(tree quoted-key 2.0.0 "  'minimumSupportedRelease': '2.1.0',")" 'effective minimumSupportedRelease 2.1.0 (declared) is above the platform version 2.0.0'
expect 1 'a quoted key with an invalid value is reported, not skipped' "$(tree quoted-invalid 2.0.0 "  'minimumSupportedRelease': 'latest',")" "'latest' is not a valid semver version"

echo "== the EFFECTIVE floor: the framework clamps anything below its constant up to it =="
expect 0 "a declared 0.0.0 is the framework's 0.82.0, under platform 2.0.0" "$(tree clamp-ok 2.0.0 "  minimumSupportedRelease: '0.0.0',")" 'raises any floor below 0.82.0 to 0.82.0'
expect 1 "a declared 0.0.0 is still above a 0.36.1 platform once clamped (the #776 shape)" "$(tree clamp-high 0.36.1 "  minimumSupportedRelease: '0.0.0',")" "effective minimumSupportedRelease 0.82.0 (the framework's floor"
expect 1 'no declared floor at all is clamped too' "$(tree clamp-undeclared 2.0.0 '' 2.1.0)" 'declared nothing'
expect 1 'a clamp above the platform hides every qadam' "$(tree clamp-moved 2.0.0 "  minimumSupportedRelease: '1.0.0'," 2.0.1)" 'effective minimumSupportedRelease 2.0.1'
expect 1 'the effective floor is compared against the ceiling' "$(tree clamp-ceiling 2.0.0 "  minimumSupportedRelease: '0.0.0',
  maximumSupportedRelease: '0.50.0',")" 'effective minimumSupportedRelease 0.82.0 is above maximumSupportedRelease 0.50.0'
d="$(tree clamp-gone 2.0.0 '')"; printf 'export const SOMETHING_ELSE = 1;\n' > "$d/packages/qadams/framework/src/lib/context/versioning.ts"
expect 2 'a framework without the clamp constant -> UNKNOWN, not a guess' "$d" 'UNKNOWN'

echo "== UNKNOWN =="
d="$(tree no-version 2.0.0 '')"; printf '{ "name": "qadam-flow" }\n' > "$d/package.json"
expect 2 'root package.json without a version' "$d" 'UNKNOWN'
d="$(tree empty 2.0.0 '')"; rm -rf "$d/packages/qadams/community"
expect 2 'no qadams at all' "$d" 'UNKNOWN'
bare_root_out="$(timeout 60 node "$checker" --root 2>&1)"; bare_root_rc=$?
if [ "$bare_root_rc" -eq 2 ] && printf '%s' "$bare_root_out" | grep -qF 'UNKNOWN'; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); printf 'FAIL  a bare --root -> UNKNOWN, not a crash (want 2, got %s)\n' "$bare_root_rc"
  printf '%s\n' "$bare_root_out" | sed 's/^/        | /'
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
