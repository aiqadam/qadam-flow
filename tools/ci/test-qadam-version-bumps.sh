#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-qadam-version-bumps.mjs.
#
# The checker is a git-diff gate over changed qadam package.json files, so the fixtures are a
# throwaway git repository with a base commit and a head commit, exactly like the range
# `_verify.yml` threads through (PR_BASE_SHA...PR_HEAD_SHA). These pin both the cases the gate
# must catch (a dependency section changed with no version bump) and the cases it must stay
# silent on (a version bump, a non-dependency edit, an unversionable version).
#
# Run from the "Lint + unit test suite" job (it only needs node + git).
#
#   tools/ci/test-qadam-version-bumps.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-qadam-version-bumps.mjs"

pass=0
fail=0

cleanup() {
  [ -n "${root:-}" ] && rm -rf "$root"
  return 0
}
trap cleanup EXIT

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# A fresh repo with one qadam package.json at `version`, carrying `exifreader` and `csv-parse`.
new_repo() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "$root/packages/qadams/core/image-helper"
  cat > "$root/packages/qadams/core/image-helper/package.json" <<'EOF'
{
  "name": "@aiqadam/qadam-image-helper",
  "version": "0.1.0",
  "dependencies": {
    "@aiqadam/shared": "workspace:*",
    "csv-parse": "6.14.2",
    "exifreader": "4.20.0"
  }
}
EOF
  git -C "$root" init -q
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name test
  git -C "$root" add -A
  git -C "$root" commit -qm base
  base_sha="$(git -C "$root" rev-parse HEAD)"
}

# Commit the current working tree as the head, then run the checker over base...head.
commit_head() {
  git -C "$root" add -A
  git -C "$root" commit -qm head
  head_sha="$(git -C "$root" rev-parse HEAD)"
}

run_check() {
  out="$(cd "$root" && PR_BASE_SHA="$base_sha" PR_HEAD_SHA="$head_sha" node "$checker" "$@" 2>&1)"
  status=$?
}

expect_status() {
  if [ "$status" -eq "$1" ]; then
    ok
  else
    bad "expected exit $1, got $status — $2\n$out"
  fi
}

expect_contains() {
  case "$out" in
    *"$1"*) ok ;;
    *) bad "expected output to contain '$1' — $2\n$out" ;;
  esac
}

expect_not_contains() {
  case "$out" in
    *"$1"*) bad "expected output NOT to contain '$1' — $2\n$out" ;;
    *) ok ;;
  esac
}

echo "== a dependency change with no version bump is caught =="

new_repo
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 1 "dependency changed, version untouched"
expect_contains "1 qadam package.json changed a dependency without bumping its own version" "the violation is counted"
expect_contains "packages/qadams/core/image-helper/package.json" "the violation names the file"
expect_contains "needs patch: 0.1.0 -> 0.1.1" "a non-major dependency move suggests patch"

echo "== --fix applies the patch bump and the check then passes =="

run_check --fix
expect_status 0 "--fix exits clean"
expect_contains "bumped packages/qadams/core/image-helper/package.json: 0.1.0 -> 0.1.1" "--fix reports the bump"
grep -q '"version": "0.1.1"' "$root/packages/qadams/core/image-helper/package.json" && ok || bad "--fix wrote 0.1.1"
# The checker reads head from git, not the working tree — commit the fix before re-checking, the
# same way the workflow commits and pushes it.
commit_head
run_check
expect_status 0 "the bumped tree passes"

echo "== a major dependency move suggests the 0.x breaking slot (minor) =="

new_repo
sed -i 's/"csv-parse": "6.14.2"/"csv-parse": "7.0.0"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 1 "major dependency move with no bump is caught"
expect_contains "needs minor: 0.1.0 -> 0.2.0" "a major dependency move suggests minor"
run_check --fix
expect_status 0 "--fix exits clean"
grep -q '"version": "0.2.0"' "$root/packages/qadams/core/image-helper/package.json" && ok || bad "--fix wrote 0.2.0 (minor)"

echo "== a version bump alongside the dependency change passes =="

new_repo
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 0 "dependency change paired with a bump"

echo "== a non-dependency edit needs no bump =="

new_repo
python3 - "$root/packages/qadams/core/image-helper/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["description"] = "now with a description"
json.dump(d, open(p, "w"), indent=2)
PY
commit_head
run_check
expect_status 0 "a description edit is out of scope"

echo "== a file that is not a qadam package.json is out of scope =="

new_repo
mkdir -p "$root/packages/server/api"
printf '{\n  "name": "@aiqadam/api",\n  "version": "0.1.0",\n  "dependencies": { "qs": "6.14.2" }\n}\n' > "$root/packages/server/api/package.json"
git -C "$root" add -A
git -C "$root" commit -qm add-api
sed -i 's/"qs": "6.14.2"/"qs": "6.16.0"/' "$root/packages/server/api/package.json"
commit_head
run_check
expect_status 0 "a server package.json dependency change is not a qadam concern"

echo "== an unversionable version is left alone, not rewritten =="

new_repo
sed -i 's/"version": "0.1.0"/"version": "0.1.0-beta.1"/' "$root/packages/qadams/core/image-helper/package.json"
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 0 "a prerelease version is not mechanically bumpable, so the gate stays silent"

echo "== when base is already ahead, --fix bumps above base (one push, not two) =="

new_repo
sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' "$root/packages/qadams/core/image-helper/package.json"
git -C "$root" add -A && git -C "$root" commit -qm base-ahead
base_sha="$(git -C "$root" rev-parse HEAD)"
sed -i 's/"version": "0.1.1"/"version": "0.1.0"/' "$root/packages/qadams/core/image-helper/package.json"
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 1 "a branch version below base still fails"
run_check --fix
expect_status 0 "--fix exits clean"
grep -q '"version": "0.1.2"' "$root/packages/qadams/core/image-helper/package.json" && ok || bad "--fix bumped above base to 0.1.2"
commit_head
run_check
expect_status 0 "the bumped tree passes against the ahead base"

echo "== a nested \"version\" key is not the one rewritten =="

new_repo
python3 - "$root/packages/qadams/core/image-helper/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
out = {"name": d["name"], "publishConfig": {"version": "0.1.0"}, "version": "0.1.0", "dependencies": d["dependencies"]}
json.dump(out, open(p, "w"), indent=2)
PY
git -C "$root" add -A && git -C "$root" commit -qm nested-base
base_sha="$(git -C "$root" rev-parse HEAD)"
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check --fix
expect_status 0 "--fix exits clean"
grep -q '"version": "0.1.1"' "$root/packages/qadams/core/image-helper/package.json" && ok || bad "the top-level version was bumped"
if python3 - "$root/packages/qadams/core/image-helper/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["publishConfig"]["version"] == "0.1.0", d["publishConfig"]
PY
then ok; else bad "publishConfig.version was left untouched"; fi

echo "== a modified package.json that is not valid JSON fails loudly =="

new_repo
printf '{\n  "name": "@aiqadam/qadam-image-helper",\n  "version": "0.1.0",\n}\n' > "$root/packages/qadams/core/image-helper/package.json"
commit_head
run_check
expect_status 1 "invalid JSON is not a pass"
expect_contains "not valid JSON" "the reason is named"
expect_not_contains "all carry a version bump" "no false pass"

echo "== --fix refuses when the working tree no longer holds the diff head version =="

new_repo
sed -i 's/"exifreader": "4.20.0"/"exifreader": "4.41.1"/' "$root/packages/qadams/core/image-helper/package.json"
commit_head
# Move the working-tree version out from under the diff (e.g. a dirty local tree).
sed -i 's/"version": "0.1.0"/"version": "0.9.9"/' "$root/packages/qadams/core/image-helper/package.json"
run_check --fix
expect_status 1 "--fix refuses rather than rewrite a moved value"
expect_contains "could not rewrite the version" "the refusal is named"
expect_not_contains "nothing to bump" "a refusal is not reported as a clean no-op"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "qadam version-bumps checker tests FAILED."
  exit 1
fi
echo "qadam version-bumps checker tests passed."
