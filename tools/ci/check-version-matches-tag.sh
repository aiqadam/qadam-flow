#!/usr/bin/env bash
#
# Release gate: the tag being released must agree with the version the built
# artifact will report about itself.
#
# WHY THIS EXISTS. `packages/server/utils/src/ap-version.ts` reads the version
# straight off the root `package.json` at runtime:
#
#     JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json')))
#
# and `apVersionUtil.getCurrentRelease()` is what feeds `ApFlagId.CURRENT_VERSION`
# (the version in the UI), the `LATEST_VERSION` comparison that raises the
# "a new version is available" prompt, the telemetry payload, the app/worker
# version-skew gate, and the `release` argument the qadam registry is resolved
# with. Nothing bumps that file automatically — both previous releases did it in
# a hand-written `chore(release): vX.Y.Z` commit — and until this script,
# nothing checked it either.
#
# So `git tag v2.0.0 && git push --tags` against a tree still saying `1.1.0`
# built, published `:2.0.0` AND `:latest`, and cut a GitHub Release, all green,
# shipping an image that told every operator it was 1.1.0 and offered them an
# upgrade to the version they were already running. That is the same shape as
# the breaking-change gate's founding story (#210): a control that was one
# person remembering. See #326 for the instance that prompted this.
#
# WHY IT LIVES IN release.yml AND NOT ci.yml. There is no tag on a pull request,
# so there is nothing to compare a PR's `package.json` against — the same
# reasoning `check-breaking-change-changelog.sh` gives for its own placement.
# The tag push is the first and only moment the two values both exist.
#
# WHY THERE IS NO OVERRIDE TRAILER. Its sibling gate has
# `Release-Gate-Override:` because "does this breaking change need a changelog
# entry" is a judgement call that can legitimately go either way. This one is
# not: a tag that disagrees with the version the binary reports is always wrong,
# and the fix (bump, re-cut the tag) is a minute's work.
#
# WHY EXACT STRING EQUALITY AND NOT A SEMVER COMPARE. `release.yml` publishes
# the image as `type=semver,pattern={{version}}`, i.e. the tag's own text. If
# this gate normalised through semver, `v2.0.0+build.1` would match a
# `package.json` of `2.0.0` — and then the published image tag would not match
# the version the app reports, which is the entire failure being prevented.
#
#   tools/ci/check-version-matches-tag.sh <tag>
#
#   exit:  0 = the tag and package.json agree
#          1 = they disagree
#          2 = UNKNOWN, could not measure — treat as failure
#
# There is no inline self-test here, unlike its sibling: that one hand-rolls an
# awk section parser and a commit classifier that can rot silently, whereas the
# only parser in this file is `JSON.parse`. The reject cases live in
# tools/ci/test-version-tag-gate.sh, which runs on every PR.

set -uo pipefail

MANIFEST='package.json'

report=''

say() {
  printf '%s\n' "$*"
  report="${report}$*
"
}

flush_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### Release gate: tag vs package.json version\n\n'
      printf '```\n%s```\n' "$report"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

die_unknown() {
  say ''
  say 'UNKNOWN — the gate could not measure the release.'
  say "  $1"
  say ''
  say 'This is a failure, not a pass. A version that could not be read is not a version that matches.'
  printf '::error title=Release gate UNKNOWN::%s\n' "$1"
  flush_summary
  exit 2
}

# Prints the `version` string from a package.json, or exits with a code naming
# what went wrong. Delegating to node rather than grepping is deliberate: a
# `"version": "…"` regex over JSON is the same class of hand-rolled parser that
# #242 reverted, and node is already a hard requirement of every job that could
# possibly run this.
read_manifest_version() {
  node -e '
    const fs = require("fs")
    let raw
    try { raw = fs.readFileSync(process.argv[1], "utf8") }
    catch { process.exit(3) }
    let parsed
    try { parsed = JSON.parse(raw) }
    catch { process.exit(4) }
    const version = parsed === null || typeof parsed !== "object" ? undefined : parsed.version
    if (typeof version !== "string" || version.trim() === "") { process.exit(5) }
    process.stdout.write(version)
  ' "$1"
}

main() {
  local tag="${1:-}"

  [ -n "$tag" ] || die_unknown 'no tag argument; usage: check-version-matches-tag.sh <tag>'

  command -v node >/dev/null 2>&1 \
    || die_unknown 'node is not on PATH, so package.json cannot be read. Add actions/setup-node ahead of this step.'

  local toplevel
  toplevel="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || die_unknown 'not inside a git repository'
  cd "$toplevel" || die_unknown "cannot cd to repository root $toplevel"

  case "$tag" in
    v*) ;;
    *) die_unknown "tag '${tag}' does not start with 'v'; release.yml only triggers on 'v*' so this is not a release tag" ;;
  esac

  local expected="${tag#v}"
  [ -n "$expected" ] || die_unknown "tag '${tag}' has no version after the 'v' prefix"

  local actual rc
  actual="$(read_manifest_version "$toplevel/$MANIFEST")"
  rc=$?
  case "$rc" in
    0) ;;
    3) die_unknown "${MANIFEST} is missing or unreadable at the repository root" ;;
    4) die_unknown "${MANIFEST} is not parseable JSON" ;;
    5) die_unknown "${MANIFEST} has no non-empty string 'version' field" ;;
    *) die_unknown "reading ${MANIFEST} failed with an unexpected status (${rc})" ;;
  esac

  say 'release gate: tag vs package.json version'
  say "  tag being released : ${tag}"
  say "  version it implies : ${expected}"
  say "  ${MANIFEST}      : ${actual}"
  say ''

  if [ "$expected" = "$actual" ]; then
    say "  ✓ ${MANIFEST} declares the version this tag publishes."
    say ''
    say 'PASS — the image will report the version it is tagged with.'
    flush_summary
    exit 0
  fi

  say "  ✗ ${MANIFEST} says '${actual}', but this tag publishes '${expected}'."
  say ''
  say 'FAIL — the release would ship an image that misreports its own version.'
  say ''
  say "apVersionUtil.getCurrentRelease() reads ${MANIFEST} at runtime, so '${actual}' is"
  say 'what this build would report to the UI, to telemetry, to the app/worker version'
  say 'check and to the qadam registry lookup — while being published as'
  say "ghcr.io/aiqadam/qadam-flow:${expected} and :latest."
  say ''
  say 'To fix, on the branch the tag points at:'
  say ''
  say "  1. Set \"version\": \"${expected}\" in ${MANIFEST} and commit it"
  say "     (the convention is a 'chore(release): ${tag}' commit that also carries"
  say '      the docs/about/changelog.mdx entry).'
  say "  2. Re-cut the tag: git tag -d ${tag} && git tag ${tag} && git push -f origin ${tag}"
  say ''
  say 'Deciding the other way — editing the tag to match a stale package.json — is'
  say 'almost never right: the version users see should be the one they pulled.'
  printf '::error title=Tag does not match package.json::%s publishes %s but %s declares %s\n' \
    "$tag" "$expected" "$MANIFEST" "$actual"
  flush_summary
  exit 1
}

main "$@"
