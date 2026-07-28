#!/usr/bin/env bash
#
# Tests for tools/ci/check-breaking-change-changelog.sh — the release gate that
# refuses to ship a declared breaking change without a changelog entry.
#
# The point of this file is the REJECT cases. A gate exercised only on the happy
# path is not a gate: it would pass identically if its classifier matched
# nothing at all, which is exactly the failure mode CLAUDE.md's "commands that
# look like verification but verify nothing" list is made of. So every accept
# case below has a paired reject case that differs in one thing, and the UNKNOWN
# block asserts that an unmeasurable release fails instead of sailing through.
#
# Fixtures are real throwaway git repositories built in a temp dir: real
# commits, real tags, real annotated-tag objects. Nothing about git's log format
# or tag plumbing is stubbed, because the gate's whole job is reading those.
#
#   tools/ci/test-breaking-change-gate.sh
#
# Run from the `Lint + Unit Tests` job, which is unconditional, so it can never
# be skipped by the docs-only path filter. Pure shell, no install needed. Every
# case runs under `timeout`, so a regression that hangs fails the job instead of
# stalling it for six hours.

set -uo pipefail

# Fixture identity, forced. Ambient GIT_AUTHOR_*/GIT_COMMITTER_* leak into
# `git commit` ahead of repo config, and in at least one dev container they are
# set to the empty string, which makes every fixture commit die with
# "empty ident name (for <>) not allowed".
export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="${here}/check-breaking-change-changelog.sh"
doc_path='docs/install/configuration/breaking-changes.mdx'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

CASE_TIMEOUT=60

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

# new_repo <name> — fresh repo with deterministic identity and no signing.
new_repo() {
  local dir="${tmp}/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name 'Fixture Author'
  git -C "$dir" config user.email 'fixture@example.invalid'
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config tag.gpgsign false
  printf '%s\n' "$dir"
}

# commit <dir> <file-marker> <message> [extra-paragraph]
commit() {
  local dir="$1" marker="$2" msg="$3" extra="${4:-}"
  local -a args=(-m "$msg")
  [ -n "$extra" ] && args+=(-m "$extra")
  mkdir -p "$(dirname "${dir}/${marker}")"
  printf '%s\n' "$RANDOM$RANDOM" >> "${dir}/${marker}"
  git -C "$dir" add -A
  git -C "$dir" commit -q --no-gpg-sign "${args[@]}"
}

# write_doc <dir> <body...> — replaces the changelog file, staged not committed.
write_doc() {
  local dir="$1"
  shift
  mkdir -p "$(dirname "${dir}/${doc_path}")"
  printf '%s\n' "$@" > "${dir}/${doc_path}"
}

# run_gate <dir> <tag> — captures output, returns the gate's exit code.
run_gate() {
  local dir="$1" tag="$2" rc
  last_out="$(cd "$dir" && timeout "$CASE_TIMEOUT" "$gate" "$tag" 2>&1)"
  rc=$?
  if [ "$rc" -eq 124 ]; then
    last_out="${last_out}
[timed out after ${CASE_TIMEOUT}s]"
  fi
  return "$rc"
}

# expect <want-rc> <label> <dir> <tag> [substring that must appear in output]
expect() {
  local want="$1" label="$2" dir="$3" tag="$4" needle="${5:-}" got
  run_gate "$dir" "$tag"
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

# --- the standard release fixture -----------------------------------------
#
# v1.0.0 (baseline, changelog with one old section) → some commits → v1.1.0.
# Callers vary exactly one thing to flip the verdict.
#
# build_release <name> <breaking-subject|-> <doc-state> [tag-args...]
#   doc-state: released | unreleased | untouched | absent
build_release() {
  local name="$1" subject="$2" doc_state="$3" trailer="${4:-}"
  local dir
  dir="$(new_repo "$name")"

  if [ "$doc_state" != absent ]; then
    write_doc "$dir" '---' 'title: "Breaking Changes"' '---' '' '## 1.0.0' '' '- the old one' ''
  fi
  commit "$dir" 'src/a.txt' 'feat: baseline'
  git -C "$dir" tag v1.0.0

  commit "$dir" 'src/b.txt' 'fix: something ordinary'
  if [ "$subject" != '-' ]; then
    commit "$dir" 'src/c.txt' "$subject" "$trailer"
  fi

  case "$doc_state" in
    released)
      write_doc "$dir" '---' 'title: "Breaking Changes"' '---' '' '## 1.1.0' '' '- the new breaking thing' '' '## 1.0.0' '' '- the old one' ''
      commit "$dir" "$doc_path" 'docs: record the breaking change'
      ;;
    unreleased)
      write_doc "$dir" '---' 'title: "Breaking Changes"' '---' '' '## Unreleased' '' '- the new breaking thing' '' '## 1.0.0' '' '- the old one' ''
      commit "$dir" "$doc_path" 'docs: record the breaking change under Unreleased'
      ;;
    untouched | absent) ;;
  esac

  git -C "$dir" tag v1.1.0
  printf '%s\n' "$dir"
}

echo "== REJECT cases (the ones that make this a gate) =="

d="$(build_release reject-undocumented 'feat!: remove the WORKER_AND_APP mode' untouched)"
expect 1 'breaking `type!:` commit + changelog never touched -> FAIL' \
  "$d" v1.1.0 'FAIL — a breaking change is shipping without a changelog entry.'

d="$(build_release reject-footer $'feat: rework the entrypoint\n\nBREAKING CHANGE: AP_CONTAINER_TYPE is now required' untouched)"
expect 1 'breaking via `BREAKING CHANGE:` footer + changelog never touched -> FAIL' \
  "$d" v1.1.0 'FAIL'

# The near-miss this whole gate is modelled on: the entry was written, but under
# "Unreleased", so the released version has no section of its own.
d="$(build_release reject-unreleased-not-renamed 'feat!: remove the WORKER_AND_APP mode' unreleased)"
expect 1 'entry written but left under `## Unreleased` -> FAIL, and says so' \
  "$d" v1.1.0 "forgotten rename"

# Documented before the previous release: the section exists at the tag but the
# file was not touched in this range, so it belongs to an earlier release.
d="$(new_repo reject-doc-predates)"
write_doc "$d" '## 1.1.0' '' '- written far too early' ''
commit "$d" 'src/a.txt' 'feat: baseline'
git -C "$d" tag v1.0.0
commit "$d" 'src/c.txt' 'feat!: remove the thing'
git -C "$d" tag v1.1.0
expect 1 'version section predates the range (changelog untouched since v1.0.0) -> FAIL' \
  "$d" v1.1.0 'was not modified anywhere in'

# A prerelease between the two releases must not shrink the range. The breaking
# commit sits before the rc; releasing v1.1.0 must still see it, because
# `:latest` only ever moves on non-prerelease tags.
d="$(new_repo reject-prerelease-hop)"
write_doc "$d" '## 1.0.0' '' '- old' ''
commit "$d" 'src/a.txt' 'feat: baseline'
git -C "$d" tag v1.0.0
commit "$d" 'src/c.txt' 'feat!: remove the thing'
git -C "$d" tag v1.1.0-rc.1
commit "$d" 'src/d.txt' 'fix: polish'
git -C "$d" tag v1.1.0
expect 1 'breaking commit hidden behind an rc tag is still in range -> FAIL' \
  "$d" v1.1.0 'previous release   : v1.0.0'

# First release ever, breaking commit, no changelog entry.
d="$(new_repo reject-first-tag)"
write_doc "$d" '## Unreleased' '' '- something' ''
commit "$d" 'src/a.txt' 'feat!: the very first breaking commit'
git -C "$d" tag v1.0.0
expect 1 'first tag with no previous release, undocumented -> FAIL (not skipped)' \
  "$d" v1.0.0 '(root)..v1.0.0'

echo "== UNKNOWN cases (must fail, must NOT read as 'nothing found') =="

d="$(build_release unknown-empty-range - untouched)"
git -C "$d" tag v1.2.0 v1.1.0   # same commit as v1.1.0 -> zero commits in range
expect 2 'empty commit range -> UNKNOWN, not a pass' \
  "$d" v1.2.0 'is empty — nothing was examined'

d="$(build_release unknown-no-tag - untouched)"
expect 2 'tag that does not exist -> UNKNOWN' \
  "$d" v9.9.9 'does not exist locally'

d="$(build_release unknown-not-v-prefixed - untouched)"
git -C "$d" tag release-1.2.0
expect 2 'tag without a `v` prefix -> UNKNOWN' \
  "$d" release-1.2.0 "does not start with 'v'"

d="$(build_release unknown-doc-absent 'feat!: remove the thing' absent)"
expect 2 'changelog file missing entirely -> UNKNOWN, not "nothing to check"' \
  "$d" v1.1.0 'does not exist at v1.1.0'

# actions/checkout defaults to depth 1. A shallow clone silently truncates the
# range, so it must be fatal — this is the single most likely way for the gate
# to be wrong in production.
d="$(build_release unknown-shallow 'feat!: remove the thing' untouched)"
shallow="${tmp}/shallow"
rm -rf "$shallow"
git clone -q --depth 1 --no-local "file://${d}" "$shallow" 2>/dev/null
git -C "$shallow" fetch -q --depth 1 origin 'refs/tags/v1.1.0:refs/tags/v1.1.0' 2>/dev/null
expect 2 'shallow clone -> UNKNOWN with a fetch-depth hint' \
  "$shallow" v1.1.0 'fetch-depth: 0'

# The tripwire on the tripwire: if the classifier stops classifying, the gate
# must abort rather than report a clean range. Break it on purpose and watch it
# go red — otherwise "no breaking changes found" is unfalsifiable.
d="$(build_release unknown-selftest 'feat!: remove the thing' released)"
last_out="$(cd "$d" && BREAKING_GATE_FORCE_SELFTEST_FAIL=1 timeout "$CASE_TIMEOUT" "$gate" v1.1.0 2>&1)"
rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$last_out" | grep -q 'gate self-test failed'; then
  ok
else
  fail_case 'sabotaged self-test -> UNKNOWN' "want exit 2 + self-test message, got ${rc}"
fi

echo "== ACCEPT cases =="

d="$(build_release accept-documented 'feat!: remove the WORKER_AND_APP mode' released)"
expect 0 'breaking commit + `## 1.1.0` section added in range -> PASS' \
  "$d" v1.1.0 'PASS — the breaking change is acknowledged in the changelog.'

d="$(build_release accept-footer $'feat: rework the entrypoint\n\nBREAKING CHANGE: AP_CONTAINER_TYPE is now required' released)"
expect 0 'breaking footer + documented -> PASS' "$d" v1.1.0 'PASS'

d="$(build_release accept-no-breaking - untouched)"
expect 0 'no breaking markers at all -> PASS, and says how many commits it read' \
  "$d" v1.1.0 'no unexempted breaking-change markers in 1 commits'

d="$(new_repo accept-first-tag-documented)"
write_doc "$d" '## 1.0.0' '' '- the very first breaking change' ''
commit "$d" 'src/a.txt' 'feat!: the very first breaking commit'
git -C "$d" tag v1.0.0
expect 0 'first tag, documented -> PASS' "$d" v1.0.0 'PASS'

d="$(build_release accept-prerelease-section 'feat!: remove the thing' untouched)"
git -C "$d" tag -d v1.1.0 >/dev/null
write_doc "$d" '## 1.1.0' '' '- the new breaking thing' ''
commit "$d" "$doc_path" 'docs: record it'
git -C "$d" tag v1.1.0-rc.1
expect 0 'prerelease tag accepts the base version section -> PASS' \
  "$d" v1.1.0-rc.1 'PASS'

echo "== ESCAPE HATCHES (must work, and must leave a record) =="

d="$(build_release exempt-trailer 'feat!: change an internal-only interface' untouched \
  'Breaking-Change-Exempt: internal worker RPC, no user-visible surface')"
expect 0 'per-commit `Breaking-Change-Exempt:` trailer -> PASS' \
  "$d" v1.1.0 'internal worker RPC, no user-visible surface'

d="$(build_release override-annotated 'feat!: remove the thing' untouched)"
git -C "$d" tag -d v1.1.0 >/dev/null
GIT_COMMITTER_NAME='Release Manager' GIT_COMMITTER_EMAIL='rm@example.invalid' \
  git -C "$d" tag -a v1.1.0 \
  -m $'Release 1.1.0\n\nRelease-Gate-Override: changelog lands in a follow-up, tracked in #999'
expect 0 'annotated-tag `Release-Gate-Override:` -> PASS' \
  "$d" v1.1.0 'changelog lands in a follow-up, tracked in #999'
if ! printf '%s' "$last_out" | grep -q 'Release Manager <rm@example.invalid>'; then
  fail_case 'override records who did it' 'tagger identity missing from the output'
else
  ok
fi

# The override must be impossible to apply invisibly: a lightweight tag has no
# annotation to carry it, and the same trailer sitting in a commit message must
# not be honoured as a release-level override.
d="$(build_release override-not-from-commit 'feat!: remove the thing' untouched \
  'Release-Gate-Override: sneaking this in via a commit body')"
expect 1 'override trailer in a commit body is NOT a release override -> FAIL' \
  "$d" v1.1.0 'FAIL'

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
