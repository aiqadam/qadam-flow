#!/usr/bin/env bash
#
# Fixture tests for tools/ci/release-guard.mjs (#852): the two properties the zero-touch publish
# loop cannot leave to a reviewer because the release PR merges itself —
#   - at most 30 qadams with a pending release in one release PR (the npm publish cap);
#   - no pending `"@aiqadam/platform": major`, which would raise the root version to 2.0.0 ahead of
#     the v2.0.0 milestone (ADR-0001).
#
# Same construction as test-main-version.sh: throwaway trees, accept and reject cases, and UNKNOWN
# (exit 2) whenever the guard would have to guess — an unreadable plan is never a pass.
#
#   tools/ci/test-release-guard.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/release-guard.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$3" "$2"; fi
}

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# new_tree <name> — the files release-guard.mjs reads.
new_tree() {
  local dir="$tmp/$1"
  mkdir -p "$dir"
  write "$dir/package.json" '{ "name": "qadam-flow", "version": "1.1.0", "private": true }'
  write "$dir/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "1.1.0", "private": true }'
  write "$dir/.changeset/config.json" '{ "baseBranch": "main", "privatePackages": { "version": true, "tag": false }, "ignore": [] }'
  write "$dir/.changeset/README.md" '# Changesets'
  printf '%s\n' "$dir"
}

# qadam_changeset <tree> <file> <name> <level>
qadam_changeset() {
  write "$2" "---
\"$3\": $4
---

A pending release for $3."
}

out=''
rc=0
run_guard() { out="$(node "$guard" "$@" 2>&1)"; rc=$?; }

echo "== release-guard =="

d="$(new_tree empty)"
run_guard --root "$d"
check 'no pending changesets -> SAFE' "$rc" '0'
check 'and it says so' "$(grep -c 'SAFE' <<<"$out")" '1'

d="$(new_tree thirty)"
for i in $(seq 1 30); do qadam_changeset "$d" "$d/.changeset/q$i.md" "@aiqadam/qadam-q$i" patch; done
run_guard --root "$d"
check 'exactly 30 qadams -> SAFE (the cap is inclusive)' "$rc" '0'
check 'and it counts 30' "$(grep -c '30 qadam' <<<"$out")" '1'

d="$(new_tree thirtyone)"
for i in $(seq 1 31); do qadam_changeset "$d" "$d/.changeset/q$i.md" "@aiqadam/qadam-q$i" patch; done
run_guard --root "$d"
check '31 qadams -> REFUSED' "$rc" '1'
check 'and it names the cap' "$(grep -c 'per-release cap' <<<"$out")" '1'

d="$(new_tree platform-major)"
qadam_changeset "$d" "$d/.changeset/one.md" "@aiqadam/qadam-slack" patch
write "$d/.changeset/platform-2-0-0.md" '---
"@aiqadam/platform": major
---

2.0.0.'
run_guard --root "$d"
check 'a pending platform major -> REFUSED even with one qadam' "$rc" '1'
check 'and it names the platform major' "$(grep -c 'platform version before the milestone' <<<"$out")" '1'

d="$(new_tree platform-minor)"
write "$d/.changeset/platform-minor.md" '---
"@aiqadam/platform": minor
---

A new capability.'
run_guard --root "$d"
check 'a pending platform minor -> SAFE' "$rc" '0'

d="$(new_tree max-override)"
for i in $(seq 1 5); do qadam_changeset "$d" "$d/.changeset/q$i.md" "@aiqadam/qadam-q$i" patch; done
run_guard --root "$d" --max-qadams 5
check '--max-qadams 5 with 5 qadams -> SAFE' "$rc" '0'
run_guard --root "$d" --max-qadams 4
check '--max-qadams 4 with 5 qadams -> REFUSED' "$rc" '1'

d="$(new_tree framework-only)"
write "$d/.changeset/fw.md" '---
"@aiqadam/qadams-framework": minor
"@aiqadam/shared": minor
---

A framework change, no qadam.'
run_guard --root "$d"
check 'framework/shared changesets are not qadams -> SAFE' "$rc" '0'

d="$(new_tree broken)"
write "$d/.changeset/broken.md" '---
not a front matter line at all
---

body'
run_guard --root "$d"
check 'an unparseable changeset -> UNKNOWN (exit 2), never a pass' "$rc" '2'

d="$(new_tree missing-config)"
rm -f "$d/.changeset/config.json"
run_guard --root "$d"
check 'a missing .changeset/config.json -> UNKNOWN (exit 2)' "$rc" '2'

run_guard --root "$tmp" --nope
check 'an unexpected argument -> UNKNOWN (exit 2)' "$rc" '2'

d="$(new_tree json)"
qadam_changeset "$d" "$d/.changeset/one.md" "@aiqadam/qadam-slack" patch
run_guard --root "$d" --json
check '--json prints parseable JSON' "$(node -e "JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('ok')" <<<"$out")" 'ok'
check 'and reports safe:true with one qadam' "$(node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r.safe+' '+r.qadams.length)" <<<"$out")" 'true 1'

echo
if [ "$fail" -gt 0 ]; then
  echo "release-guard tests FAILED: ${pass} passed, ${fail} failed"
  exit 1
fi
echo "release-guard tests passed: ${pass} passed, 0 failed"
