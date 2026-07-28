#!/usr/bin/env bash
#
# Release gate: a breaking change may not ship undocumented.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS  (read this before deleting it at 2 a.m.)
# ---------------------------------------------------------------------------
# PR #210 removed the `WORKER_AND_APP` launch mode and made `AP_CONTAINER_TYPE`
# required. Every all-in-one `docker run … qadam-flow:latest` install refuses to
# start once that ships, and there is no automated migration from the embedded
# PGLite database to PostgreSQL — so the upgrade is not "restart and move on",
# it is "your data needs moving by hand".
#
# That change *was* documented, in docs/install/configuration/breaking-changes.mdx.
# It was documented because a human noticed. Nothing mechanical would have
# stopped the release if nobody had. The only reason the miss was survivable is
# that `:latest` is not published by merges to `main`: ci.yml's `image` job
# pushes `type=ref,event=branch` and `type=sha` only (`:main`, `:sha-…`), and
# `latest` appears exactly once in the repo — in release.yml's `publish` job,
# on a tag push. So the window between "merged" and "users get it" is a tag,
# and a tag is a place a check can stand.
#
# Memory is not a control. The person cutting the release is often not the
# person who wrote the breaking commit, may be cutting it weeks later, and is
# reading a 40-commit range. "We'll remember to update breaking-changes.mdx" is
# the same class of assurance as "we'll remember to filter by projectId".
#
# ---------------------------------------------------------------------------
# WHAT THIS GUARANTEES, AND WHAT IT DOES NOT
# ---------------------------------------------------------------------------
# Guarantees: if any commit in the released range *declares itself* breaking —
# conventional-commit `type!:` subject, or a `BREAKING CHANGE:` /
# `BREAKING-CHANGE:` footer — then the changelog file must have been touched in
# that range AND must carry a non-empty `## <version>` section for the version
# being released. Otherwise the release fails.
#
# Does NOT guarantee: that a breaking change which nobody marked as breaking is
# caught. This gate reads declarations, not behaviour. A silent contract change
# in a squash-merged `fix:` commit passes it. It also does not read the *content*
# of the changelog section — a section saying "n/a" satisfies it. It raises the
# floor from "someone has to remember" to "someone has to lie on purpose or use
# the override"; it is not a substitute for review.
#
# ---------------------------------------------------------------------------
# IF THIS FAILED ON YOUR RELEASE
# ---------------------------------------------------------------------------
# The output above the failure names the offending commits. Thirty-second triage:
#
#   * Commits listed and the changelog has no `## <version>` section?
#     Real finding. Rename the `## Unreleased` heading to `## <version>` (and
#     add the entry if it is missing), commit, re-tag.
#
#   * A listed commit genuinely needs no changelog entry (e.g. it breaks an
#     internal-only interface)? The author should have put a
#     `Breaking-Change-Exempt: <reason>` trailer on it. You can add the trailer
#     on a follow-up commit only by rewriting history, so at release time use
#     the release-level override below instead.
#
#   * You need to ship now and argue later? Re-cut the tag as an ANNOTATED tag
#     whose message contains a line:
#
#         Release-Gate-Override: <reason>
#
#     e.g. `git tag -a v1.2.0 -m "Release-Gate-Override: docs land in #999"`.
#     The gate then passes and prints the tagger's name, email, date and reason.
#     That record lives in the tag object forever and is visible to anyone who
#     runs `git show v1.2.0`. It is deliberately more effort than editing the
#     changelog, and deliberately impossible to do invisibly. A lightweight tag
#     cannot carry an override — that is on purpose.
#
#   * Exit code 2 with an UNKNOWN banner? That is the gate saying it could not
#     measure, not that it found something. Almost always a shallow checkout
#     (`fetch-depth: 0` missing) or a tag that is not reachable. Fix the input;
#     do not reinterpret the silence as a pass. See below.
#
# ---------------------------------------------------------------------------
# WHY IT FAILS CLOSED
# ---------------------------------------------------------------------------
# CLAUDE.md keeps a list of "commands that look like verification but verify
# nothing" — a tsc invocation that type-checks zero files, a turbo filter that
# skips a package, a `jq 'all(…)'` over a set that has not populated yet. Every
# one of them reported success from an empty measurement. This script refuses to
# join that list: an empty commit range, a missing tag, a shallow clone, a
# missing changelog file, or a self-test that says the parsers no longer parse
# all exit 2 (UNKNOWN) and fail the release. "Nothing matched" is never rendered
# as "nothing is wrong".
#
# The self-test is the part that catches the sneakiest version of this: if git's
# log format changes, or someone edits a regex, the classifier would quietly
# match nothing and every release would sail through. `gate_selftest` runs the
# real classifier and the real section parser over fixed inputs with known
# answers on every invocation, and aborts if any answer changed.
#
#   usage: tools/ci/check-breaking-change-changelog.sh <tag>
#   exit:  0 = pass (or documented override)  1 = undocumented breaking change
#          2 = UNKNOWN, could not measure — treat as failure
#
# Tested by tools/ci/test-breaking-change-gate.sh, including cases it must reject.

set -uo pipefail

DOC_PATH='docs/install/configuration/breaking-changes.mdx'
EXEMPT_TRAILER='Breaking-Change-Exempt'
OVERRIDE_TRAILER='Release-Gate-Override'

report=''

say() {
  printf '%s\n' "$*"
  report="${report}$*
"
}

flush_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### Release gate: breaking changes vs changelog\n\n'
      printf '```\n%s```\n' "$report"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

die_unknown() {
  say ''
  say 'UNKNOWN — the gate could not measure the release.'
  say "  $1"
  say ''
  say 'This is a failure, not a pass. An unmeasured range is not an empty range.'
  printf '::error title=Release gate UNKNOWN::%s\n' "$1"
  flush_summary
  exit 2
}

# Returns 0 if the commit message declares itself breaking.
# Two signals, both from Conventional Commits: a `!` before the colon in the
# subject, and a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer anywhere in the
# body. Squash merges put the PR title in the subject, and pr-title.yml already
# validates that title as a conventional commit, so the subject signal is the
# one that actually fires in this repo (#210 is the worked example).
is_breaking_message() {
  local msg="$1" subject
  subject="${msg%%$'\n'*}"
  if printf '%s' "$subject" | grep -Eq '^[a-zA-Z]+(\([^)]*\))?!:'; then
    return 0
  fi
  if printf '%s\n' "$msg" | grep -Eq '^BREAKING[ -]CHANGE:'; then
    return 0
  fi
  return 1
}

# Prints the exemption reason if the message carries the trailer, else nothing.
exempt_reason() {
  printf '%s\n' "$1" \
    | grep -E "^${EXEMPT_TRAILER}:" \
    | head -n 1 \
    | sed -E "s/^${EXEMPT_TRAILER}:[[:space:]]*//"
}

# Prints the body of the `## <heading>` section of an mdx document, up to the
# next `## ` heading. Empty output means "heading absent or section empty" —
# the caller must not distinguish those two, because both fail.
section_body() {
  local doc="$1" want="$2"
  printf '%s\n' "$doc" | awk -v want="$want" '
    { line = $0; sub(/[[:space:]]+$/, "", line) }
    line ~ /^## / {
      hdr = substr(line, 4)
      sub(/^[[:space:]]+/, "", hdr)
      inside = (hdr == want)
      next
    }
    inside { print }
  '
}

has_content() {
  printf '%s\n' "$1" | grep -q '[^[:space:]]'
}

# Runs the two parsers above over fixed inputs with known answers. If any answer
# has changed, every subsequent measurement in this script is worthless, so we
# abort rather than report a clean range. See "WHY IT FAILS CLOSED" above.
gate_selftest() {
  local doc failures=''

  is_breaking_message 'feat!: drop the thing'          || failures="${failures} subject-bang"
  is_breaking_message 'fix(docker)!: drop PM2'         || failures="${failures} scoped-bang"
  is_breaking_message $'feat: x\n\nBREAKING CHANGE: y' || failures="${failures} footer-space"
  is_breaking_message $'feat: x\n\nBREAKING-CHANGE: y' || failures="${failures} footer-dash"
  is_breaking_message 'fix: an ordinary fix'           && failures="${failures} plain-misclassified"
  is_breaking_message 'chore: note the ! in prose'     && failures="${failures} prose-bang-misclassified"

  [ "$(exempt_reason $'feat!: x\n\nBreaking-Change-Exempt: internal only')" = 'internal only' ] \
    || failures="${failures} exempt-trailer"
  [ -z "$(exempt_reason 'feat!: x')" ] || failures="${failures} exempt-false-positive"

  doc=$'## Unreleased\n\n## 9.9.9\n\nsomething changed\n\n## 8.8.8\n'
  has_content "$(section_body "$doc" '9.9.9')" || failures="${failures} section-content"
  has_content "$(section_body "$doc" 'Unreleased')" && failures="${failures} empty-section-read-as-content"
  has_content "$(section_body "$doc" '7.7.7')" && failures="${failures} absent-section-read-as-content"

  if [ -n "${BREAKING_GATE_FORCE_SELFTEST_FAIL:-}" ]; then
    failures="${failures} forced-by-BREAKING_GATE_FORCE_SELFTEST_FAIL"
  fi

  if [ -n "$failures" ]; then
    die_unknown "gate self-test failed (${failures# }) — the commit/section parsers no longer behave as designed, so a clean result would be meaningless"
  fi
}

main() {
  local tag="${1:-}"

  [ -n "$tag" ] || die_unknown 'no tag argument; usage: check-breaking-change-changelog.sh <tag>'

  local toplevel
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die_unknown 'not inside a git repository'
  cd "$toplevel" || die_unknown "cannot cd to repository root $toplevel"

  gate_selftest

  # The default actions/checkout is depth 1. On a shallow clone `git rev-list`
  # returns a truncated range and every check below silently measures the wrong
  # thing, so this must be fatal rather than best-effort.
  [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = 'false' ] \
    || die_unknown 'shallow clone — the commit range cannot be computed. Set `fetch-depth: 0` on actions/checkout.'

  git rev-parse -q --verify "refs/tags/${tag}^{commit}" >/dev/null \
    || die_unknown "tag '${tag}' does not exist locally (fetch tags, or pass the tag being released)"

  case "$tag" in
    v*) ;;
    *) die_unknown "tag '${tag}' does not start with 'v'; release.yml only triggers on 'v*' so this is not a release tag" ;;
  esac

  local version base_version
  version="${tag#v}"
  base_version="${version%%-*}"

  # Previous release = nearest reachable NON-prerelease tag. Prereleases are
  # skipped deliberately: `latest` is published only for tags without a `-`
  # (see release.yml's metadata-action `enable:` conditions), so the boundary
  # that matters is "the last image users could actually have pulled". A
  # breaking change first tagged in an rc is therefore re-checked when the
  # final release goes out.
  local prev
  prev="$(git tag --merged "$tag" --list 'v*' --sort=-v:refname \
    | grep -v -- '-' \
    | grep -v -x -- "$tag" \
    | head -n 1)"

  local -a rev_args
  local range_desc first_release=false
  if [ -n "$prev" ]; then
    rev_args=("${prev}..${tag}")
    range_desc="${prev}..${tag}"
  else
    first_release=true
    rev_args=("$tag")
    range_desc="(root)..${tag}"
  fi

  local commits count
  commits="$(git rev-list "${rev_args[@]}" 2>/dev/null)" \
    || die_unknown "git rev-list ${range_desc} failed"
  count="$(printf '%s\n' "$commits" | grep -c '[0-9a-f]')"

  say 'release gate: breaking changes vs changelog'
  say "  tag being released : ${tag}  (version ${version})"
  if [ "$first_release" = true ]; then
    say '  previous release   : none — no reachable non-prerelease tag, scanning full history'
  else
    say "  previous release   : ${prev}"
  fi
  say "  commit range       : ${range_desc}  (${count} commits)"
  say "  changelog file     : ${DOC_PATH}"
  say ''

  # An empty range is the classic vacuous pass: it reads as "no breaking
  # changes found" when it actually means "nothing was examined".
  [ "$count" -gt 0 ] \
    || die_unknown "commit range ${range_desc} is empty — nothing was examined, so 'no breaking changes' would be a claim about zero commits"

  local breaking='' exempted='' sha msg subject reason
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    msg="$(git log -1 --format=%B "$sha")"
    is_breaking_message "$msg" || continue
    subject="$(git log -1 --format=%s "$sha")"
    reason="$(exempt_reason "$msg")"
    if [ -n "$reason" ]; then
      exempted="${exempted}${sha:0:9} ${subject}
    exempt: ${reason}
"
    else
      breaking="${breaking}${sha:0:9} ${subject}
"
    fi
  done <<< "$commits"

  if [ -n "$exempted" ]; then
    say "breaking-marked commits exempted by a ${EXEMPT_TRAILER} trailer:"
    while IFS= read -r line; do say "  ${line}"; done <<< "${exempted%$'\n'}"
    say ''
  fi

  if [ -z "$breaking" ]; then
    say "PASS — no unexempted breaking-change markers in ${count} commits."
    say '       (Markers are `type!:` subjects and `BREAKING CHANGE:` footers. This gate'
    say '        reads declarations, not behaviour — an unmarked breaking change passes.)'
    flush_summary
    exit 0
  fi

  say 'Commits in this range declare a breaking change:'
  while IFS= read -r line; do say "  ${line}"; done <<< "${breaking%$'\n'}"
  say ''

  # ---- was it documented? ----
  git cat-file -e "${tag}:${DOC_PATH}" 2>/dev/null \
    || die_unknown "${DOC_PATH} does not exist at ${tag} — the gate cannot tell whether the change was documented"

  local doc doc_touched=false section
  doc="$(git show "${tag}:${DOC_PATH}" 2>/dev/null)" \
    || die_unknown "could not read ${DOC_PATH} at ${tag}"

  if [ "$first_release" = true ]; then
    [ -n "$(git log --format=%H "$tag" -- "$DOC_PATH")" ] && doc_touched=true
  else
    [ -n "$(git diff --name-only "$prev" "$tag" -- "$DOC_PATH")" ] && doc_touched=true
  fi

  section="$(section_body "$doc" "$version")"
  if ! has_content "$section" && [ "$base_version" != "$version" ]; then
    section="$(section_body "$doc" "$base_version")"
  fi

  local documented=true
  if [ "$doc_touched" != true ]; then
    say "  ✗ ${DOC_PATH} was not modified anywhere in ${range_desc}."
    documented=false
  else
    say "  ✓ ${DOC_PATH} was modified in ${range_desc}."
  fi

  if has_content "$section"; then
    say "  ✓ it has a non-empty '## ${version}' section."
  else
    say "  ✗ it has no non-empty '## ${version}' section."
    documented=false
    if has_content "$(section_body "$doc" 'Unreleased')"; then
      say "    The '## Unreleased' section is non-empty — this is almost certainly a"
      say "    forgotten rename. Change that heading to '## ${version}' and re-tag."
    fi
  fi
  say ''

  if [ "$documented" = true ]; then
    say 'PASS — the breaking change is acknowledged in the changelog.'
    flush_summary
    exit 0
  fi

  # ---- escape hatch: annotated-tag override ----
  local tagtype='' annotation='' override='' tagger=''
  tagtype="$(git cat-file -t "refs/tags/${tag}" 2>/dev/null)"
  if [ "$tagtype" = 'tag' ]; then
    annotation="$(git cat-file tag "refs/tags/${tag}" 2>/dev/null)"
    override="$(printf '%s\n' "$annotation" | grep -E "^${OVERRIDE_TRAILER}:" | head -n 1 \
      | sed -E "s/^${OVERRIDE_TRAILER}:[[:space:]]*//")"
    tagger="$(printf '%s\n' "$annotation" | grep -E '^tagger ' | head -n 1 | sed -E 's/^tagger //')"
  fi

  if [ -n "$override" ]; then
    say "OVERRIDDEN — the tag annotation carries a ${OVERRIDE_TRAILER} trailer."
    say "  tagger : ${tagger:-unknown}"
    say "  reason : ${override}"
    say ''
    say 'The release proceeds. This override is part of the tag object and is'
    say "visible forever via \`git show ${tag}\`."
    printf '::warning title=Release gate overridden::%s (%s)\n' "$override" "${tagger:-unknown tagger}"
    flush_summary
    exit 0
  fi

  say 'FAIL — a breaking change is shipping without a changelog entry.'
  say ''
  say 'Fix it properly:'
  say "  1. Edit ${DOC_PATH}."
  say "  2. Rename the '## Unreleased' heading to '## ${version}' (or add that section)."
  say '  3. Commit, delete and re-create the tag, push it.'
  say ''
  say 'Or, if the commit above genuinely needs no entry, re-cut the tag as an'
  say 'annotated tag whose message contains:'
  say ''
  say "    ${OVERRIDE_TRAILER}: <why this needs no changelog entry>"
  say ''
  say "  git tag -d ${tag} && git tag -a ${tag} -m '${OVERRIDE_TRAILER}: …' && git push -f origin ${tag}"
  say ''
  say 'Do not delete this check. It exists because #210 (WORKER_AND_APP removal,'
  say 'no PGLite→PostgreSQL migration) was caught by a person noticing, not by'
  say 'anything mechanical. See the comment block at the top of'
  say "tools/ci/check-breaking-change-changelog.sh, and the 'How this page is"
  say "enforced' section of ${DOC_PATH}."
  printf '::error title=Undocumented breaking change::%s has no `## %s` entry in %s\n' "$tag" "$version" "$DOC_PATH"
  flush_summary
  exit 1
}

main "$@"
