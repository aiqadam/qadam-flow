#!/usr/bin/env bash
#
# Tests for tools/ci/check-version-matches-tag.sh — the release gate that
# refuses to publish a tag disagreeing with the version the built image will
# report about itself.
#
# Same construction, and same reasoning, as tools/ci/test-breaking-change-gate.sh:
# the gate itself only ever runs for real on a tag push, which is far too rare a
# feedback loop to catch a regression in, so its behaviour is pinned here on
# every PR. Every accept case has a paired reject case differing in one thing,
# and the UNKNOWN block asserts that an unreadable manifest fails rather than
# being reported as "no mismatch found".
#
#   tools/ci/test-version-tag-gate.sh
#
# Pure shell plus node, no install needed. Every case runs under `timeout`, so a
# regression that hangs fails the job instead of stalling it.

set -uo pipefail

# Fixture identity, forced — ambient GIT_AUTHOR_*/GIT_COMMITTER_* leak into
# `git commit` ahead of repo config, and an empty one kills every fixture.
export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="${here}/check-version-matches-tag.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The "outside a git repository" case below is only a real case if git cannot
# walk up out of the temp dir into some enclosing checkout. Without this it
# would pass or fail depending on where TMPDIR happens to live.
export GIT_CEILING_DIRECTORIES="$tmp"

CASE_TIMEOUT=60

# `timeout` is coreutils and is not on a stock macOS, where a maintainer is
# quite likely to run this before pushing. Falling back to no timeout keeps the
# suite runnable there; it says so out loud rather than quietly dropping the
# protection, since a hang would then stall instead of failing. CI is Ubuntu and
# always takes the first branch.
timeout_cmd=''
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd='timeout'
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_cmd='gtimeout'
else
  printf 'note: neither `timeout` nor `gtimeout` found — cases run unbounded\n'
fi

pass=0
fail=0
last_out=''

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
  printf '        --- gate output ---\n'
  printf '%s\n' "$last_out" | sed 's/^/        | /'
}

ok() { pass=$((pass + 1)); }

# --- fixture helpers -------------------------------------------------------

# new_repo <name> [manifest-contents] — a repo whose root package.json is
# whatever the caller says, including nothing at all.
new_repo() {
  local dir="${tmp}/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name 'Fixture Author'
  git -C "$dir" config user.email 'fixture@example.invalid'
  git -C "$dir" config commit.gpgsign false
  if [ "$#" -ge 2 ]; then
    printf '%s\n' "$2" > "${dir}/package.json"
  fi
  printf 'x\n' > "${dir}/README"
  git -C "$dir" add -A
  git -C "$dir" commit -q --no-gpg-sign -m 'fixture'
  printf '%s\n' "$dir"
}

# manifest <version> — the smallest realistic root manifest.
manifest() {
  printf '{\n  "name": "qadam-flow",\n  "version": "%s",\n  "private": true\n}\n' "$1"
}

# run_gate <dir> <tag...> — captures output, returns the gate's exit code.
# The tag is passed as-is and is deliberately NOT created in the fixture: the
# gate compares the ref name it is handed against the manifest and must not
# depend on the tag object existing.
run_gate() {
  local dir="$1" rc
  shift
  if [ -n "$timeout_cmd" ]; then
    last_out="$(cd "$dir" && "$timeout_cmd" "$CASE_TIMEOUT" "$gate" "$@" 2>&1)"
  else
    last_out="$(cd "$dir" && "$gate" "$@" 2>&1)"
  fi
  rc=$?
  if [ "$rc" -eq 124 ]; then
    last_out="${last_out}
[timed out after ${CASE_TIMEOUT}s]"
  fi
  return "$rc"
}

# expect <want-rc> <label> <dir> <tag-args...> -- <substring that must appear>
expect() {
  local want="$1" label="$2" dir="$3" needle="$4" got
  shift 4
  run_gate "$dir" "$@"
  got=$?
  if [ "$got" -ne "$want" ]; then
    fail_case "$label" "want exit ${want}, got ${got}"
    return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$last_out" | grep -qF -- "$needle"; then
    fail_case "$label" "exit ${got} was right, but output does not mention: ${needle}"
    return
  fi
  ok
}

echo "== AGREEMENT (must pass) =="

d="$(new_repo match "$(manifest 2.0.0)")"
expect 0 'tag matches the manifest -> PASS' "$d" 'PASS' v2.0.0

d="$(new_repo match-prerelease "$(manifest 2.1.0-rc.1)")"
expect 0 'prerelease tag matching a prerelease manifest -> PASS' "$d" 'PASS' v2.1.0-rc.1

echo "== DISAGREEMENT (must fail — these are the whole point) =="

# The instance that prompted the gate: the v2.0.0 tag cut against a tree whose
# root package.json was still 1.1.0 (#326).
d="$(new_repo stale-manifest "$(manifest 1.1.0)")"
expect 1 'the #326 case — v2.0.0 against a 1.1.0 manifest -> FAIL' "$d" 'FAIL' v2.0.0
if ! printf '%s' "$last_out" | grep -qF '1.1.0'; then
  fail_case 'the failure names the stale version' 'output does not contain the manifest version'
else
  ok
fi

d="$(new_repo ahead-manifest "$(manifest 2.1.0)")"
expect 1 'manifest ahead of the tag is equally wrong -> FAIL' "$d" 'FAIL' v2.0.0

# Exact string equality, not a semver compare. `release.yml` publishes
# `type=semver,pattern={{version}}` — the tag's own text — so a manifest of
# 2.0.0 under a v2.0.0+build.1 tag would publish an image tag the app does not
# report. semver.eq() would call these equal; the gate must not.
d="$(new_repo build-metadata "$(manifest 2.0.0)")"
expect 1 'build metadata in the tag is a mismatch, not an equivalence -> FAIL' \
  "$d" 'FAIL' 'v2.0.0+build.1'

# The reverse direction of the same rule: a prerelease tag must not be satisfied
# by the base version, which is exactly the fallback its sibling gate allows for
# changelog sections. Here it would ship an rc reporting itself as the final.
d="$(new_repo prerelease-vs-base "$(manifest 2.1.0)")"
expect 1 'prerelease tag against the base version -> FAIL' "$d" 'FAIL' v2.1.0-rc.1

# Leading-zero and whitespace variants a human could plausibly produce.
d="$(new_repo padded "$(manifest 2.0.0)")"
expect 1 'a differently-written same-ish version -> FAIL' "$d" 'FAIL' v2.00.0

d="$(new_repo trailing-space "$(manifest '2.0.0 ')")"
expect 1 'a trailing space in the manifest version -> FAIL' "$d" 'FAIL' v2.0.0

echo "== UNKNOWN (unmeasurable must fail, never report clean) =="

d="$(new_repo no-manifest)"
expect 2 'no package.json at the root -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo bad-json '{ "name": "qadam-flow", "version": ')"
expect 2 'unparseable package.json -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo no-version-key '{ "name": "qadam-flow", "private": true }')"
expect 2 'package.json with no version key -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo empty-version '{ "name": "qadam-flow", "version": "" }')"
expect 2 'package.json with an empty version -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo numeric-version '{ "name": "qadam-flow", "version": 2 }')"
expect 2 'package.json with a non-string version -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo array-manifest '["not", "an", "object"]')"
expect 2 'package.json that is not an object -> UNKNOWN' "$d" 'UNKNOWN' v2.0.0

d="$(new_repo no-arg "$(manifest 2.0.0)")"
expect 2 'no tag argument -> UNKNOWN' "$d" 'UNKNOWN'

d="$(new_repo bare-tag "$(manifest 2.0.0)")"
expect 2 "a tag without the 'v' prefix is not a release tag -> UNKNOWN" "$d" 'UNKNOWN' 2.0.0

d="$(new_repo v-only "$(manifest 2.0.0)")"
expect 2 "a bare 'v' with no version -> UNKNOWN" "$d" 'UNKNOWN' v

# Outside a git repository the gate cannot locate the manifest it is supposed to
# read. It must say so rather than measuring whatever happens to be in $PWD.
mkdir -p "${tmp}/not-a-repo"
printf '%s\n' "$(manifest 2.0.0)" > "${tmp}/not-a-repo/package.json"
expect 2 'run outside a git repository -> UNKNOWN' "${tmp}/not-a-repo" 'UNKNOWN' v2.0.0

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
