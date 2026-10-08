#!/usr/bin/env bash
#
# Fixture tests for the platform version of images built from `main` (ADR-0001, #798):
#   - tools/ci/compute-main-version.mjs — `<next>-main.<n>` from the root version, the pending
#     `@aiqadam/platform` changesets and the build counter; UNKNOWN (exit 2) whenever it would have
#     to guess;
#   - tools/scripts/stamp-platform-version.mjs — what the Dockerfile writes into the image's root
#     package.json: only a `-main` prerelease above the last release, never a release;
#   - semver order of what comes out: below the release it leads to, above the one before it, and
#     increasing with the counter.
#
# Same construction as test-changesets-version.sh: throwaway trees, accept and reject cases.
#
#   tools/ci/test-main-version.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
compute="$here/compute-main-version.mjs"
stamp="$repo_root/tools/scripts/stamp-platform-version.mjs"
semver="$repo_root/node_modules/semver"
[ -f "$semver/package.json" ] || { echo "main version tests FAILED: node_modules/semver not found — run bun install first." >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$3" "$2"; fi
}

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# new_tree <name> [root version] — the files compute-main-version.mjs reads.
new_tree() {
  local dir="$tmp/$1" version="${2:-1.1.0}"
  mkdir -p "$dir"
  write "$dir/package.json" "{ \"name\": \"qadam-flow\", \"version\": \"$version\", \"private\": true }"
  write "$dir/packages/platform/package.json" "{ \"name\": \"@aiqadam/platform\", \"version\": \"$version\", \"private\": true }"
  write "$dir/.changeset/config.json" '{ "baseBranch": "main", "privatePackages": { "version": true, "tag": false }, "ignore": [] }'
  write "$dir/.changeset/README.md" '# Changesets'
  printf '%s\n' "$dir"
}

changeset() { write "$1/.changeset/$2.md" "$3"; }

out=''
rc=0
run_compute() { out="$(node "$compute" "$@" 2>/dev/null)"; rc=$?; }

lt() { node -p "require('$semver').lt('$1', '$2')"; }

echo "== compute: <next> =="

d="$(new_tree none)"
run_compute --root "$d" --counter 7
check 'no pending platform changeset -> the next patch, never the release itself' "$out" '1.1.1-main.7'

d="$(new_tree patch)"; changeset "$d" a $'---\n"@aiqadam/platform": patch\n---\n\nFix.'
run_compute --root "$d" --counter 7
check 'a pending platform patch' "$out" '1.1.1-main.7'

d="$(new_tree minor)"; changeset "$d" a $'---\n"@aiqadam/platform": minor\n---\n\nNew.'
run_compute --root "$d" --counter 7
check 'a pending platform minor' "$out" '1.2.0-main.7'

d="$(new_tree major)"; changeset "$d" a $'---\n"@aiqadam/platform": major\n---\n\nBreaks.'
run_compute --root "$d" --counter 7
check 'a pending platform major: 1.1.0 -> 2.0.0, the state #798 leaves main in' "$out" '2.0.0-main.7'

d="$(new_tree highest)"
changeset "$d" a $'---\n"@aiqadam/platform": minor\n---\n\nNew.'
changeset "$d" b $'---\n"@aiqadam/qadam-slack": patch\n"@aiqadam/platform": major\n---\n\nBreaks.'
changeset "$d" c $'---\n"@aiqadam/platform": patch\n---\n\nFix.'
run_compute --root "$d" --counter 7
check 'the highest pending platform level wins, across files' "$out" '2.0.0-main.7'

d="$(new_tree others-only)"
changeset "$d" a $'---\n"@aiqadam/qadam-slack": major\n"@aiqadam/qadams-framework": minor\n---\n\nOther packages.'
run_compute --root "$d" --counter 7
check 'changesets for other packages do not move the platform' "$out" '1.1.1-main.7'

d="$(new_tree level-none)"; changeset "$d" a $'---\n"@aiqadam/platform": none\n---\n\nNothing.'
run_compute --root "$d" --counter 7
check "a 'none' platform level counts as no platform changeset" "$out" '1.1.1-main.7'

d="$(new_tree next-only)"; changeset "$d" a $'---\n"@aiqadam/platform": major\n---\n\nBreaks.'
run_compute --root "$d" --next
check '--next prints <next> alone (the release a migration made now ships in)' "$out" '2.0.0'

d="$(new_tree counter-zero)"
run_compute --root "$d" --counter 0
check 'counter 0 is a valid numeric identifier' "$out" '1.1.1-main.0'

(cd "$(new_tree cwd)" && node "$compute" --counter 3 >"$tmp/cwd.out" 2>/dev/null)
check 'without --root it reads the working directory' "$(cat "$tmp/cwd.out")" '1.1.1-main.3'

echo "== compute: UNKNOWN (exit 2, nothing printed) =="

expect_unknown() {
  local label="$1"; shift
  run_compute "$@"
  check "$label -> exit 2" "$rc" 2
  check "$label -> prints no version" "$out" ''
}

d="$(new_tree unknown-args)"
expect_unknown 'no --counter and no --next' --root "$d"
expect_unknown 'a counter with a leading zero (invalid semver)' --root "$d" --counter 01
expect_unknown 'a non-numeric counter' --root "$d" --counter abc
expect_unknown 'a negative counter' --root "$d" --counter -1
expect_unknown 'a bare --counter' --root "$d" --counter
expect_unknown 'a bare --root' --counter 7 --root
expect_unknown 'an unknown flag' --root "$d" --counter 7 --channel beta

d="$(new_tree root-prerelease 2.0.0-rc.1)"
expect_unknown 'a root that holds a prerelease, not a release' --root "$d" --counter 7

d="$(new_tree split)"
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.0.0", "private": true }'
expect_unknown 'root and @aiqadam/platform disagree' --root "$d" --counter 7

d="$(new_tree pre-mode)"; write "$d/.changeset/pre.json" '{ "mode": "pre", "tag": "rc" }'
expect_unknown 'changesets pre mode' --root "$d" --counter 7

d="$(new_tree malformed)"; changeset "$d" a $'---\n"@aiqadam/platform": huge\n---\n\nBad.'
expect_unknown 'a malformed pending changeset' --root "$d" --counter 7

d="$(new_tree fixed-group)"
write "$d/.changeset/config.json" '{ "baseBranch": "main", "fixed": [["@aiqadam/platform", "@aiqadam/qadams-framework"]], "ignore": [] }'
expect_unknown 'the platform in a fixed group' --root "$d" --counter 7

d="$(new_tree no-config)"; rm "$d/.changeset/config.json"
expect_unknown 'no .changeset/config.json' --root "$d" --counter 7

echo "== order =="

check '2.0.0-main.7 sorts above the last release 1.1.0' "$(lt 1.1.0 2.0.0-main.7)" true
check '2.0.0-main.7 sorts below the release 2.0.0 it leads to' "$(lt 2.0.0-main.7 2.0.0)" true
check 'a later build sorts higher (main.9 < main.10, numeric, not lexical)' "$(lt 2.0.0-main.9 2.0.0-main.10)" true
check 'after the release, the next patch canary sorts above it' "$(lt 2.0.0 2.0.1-main.11)" true

echo "== stamp =="

manifest() { write "$tmp/stamp/package.json" "{ \"name\": \"qadam-flow\", \"version\": \"$1\", \"private\": true, \"workspaces\": [\"packages/*\"] }"; }
version_of() { node -p "require('$1').version"; }
run_stamp() { node "$stamp" "$1" "$tmp/stamp/package.json" >/dev/null 2>&1; }

manifest 1.1.0; run_stamp ''
check 'an empty version leaves package.json alone -> exit 0' "$?" 0
check 'an empty version leaves package.json alone -> version kept' "$(version_of "$tmp/stamp/package.json")" 1.1.0

manifest 1.1.0; run_stamp 2.0.0-main.7
check 'a -main prerelease above the last release is stamped -> exit 0' "$?" 0
check 'a -main prerelease above the last release is stamped -> version' "$(version_of "$tmp/stamp/package.json")" 2.0.0-main.7
check 'the rest of package.json is kept' "$(node -p "require('$tmp/stamp/package.json').workspaces[0]")" 'packages/*'

expect_refused() {
  local label="$1" current="$2" requested="$3"
  manifest "$current"; run_stamp "$requested"
  check "$label -> exit 1" "$?" 1
  check "$label -> package.json untouched" "$(version_of "$tmp/stamp/package.json")" "$current"
}
expect_refused 'a release version (an image may never claim a release this way)' 1.1.0 2.0.0
expect_refused 'a prerelease of another channel' 1.1.0 2.0.0-rc.1
expect_refused 'a -main of the last release itself (would sort below it)' 1.1.0 1.1.0-main.7
expect_refused 'a -main below the last release' 1.1.0 1.0.9-main.7
expect_refused 'a counter with a leading zero' 1.1.0 2.0.0-main.07
expect_refused 'build metadata' 1.1.0 2.0.0-main.7+sha
expect_refused 'a tree that does not hold an X.Y.Z release' 2.0.0-rc.1 2.0.0-main.7

echo "== this repository =="

real="$(node "$compute" --counter 1 2>/dev/null)"
check 'the real tree computes a -main version' "$(printf '%s' "$real" | grep -cE '^[0-9]+\.[0-9]+\.[0-9]+-main\.1$')" 1
mkdir -p "$tmp/real" && cp "$repo_root/package.json" "$tmp/real/package.json"
node "$stamp" "$real" "$tmp/real/package.json" >/dev/null 2>&1
check 'and the stamp accepts it for the real root package.json' "$(version_of "$tmp/real/package.json")" "$real"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
