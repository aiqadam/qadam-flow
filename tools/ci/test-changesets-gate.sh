#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-changesets.mjs — ADR-0001 gate 1 (a changed versioned package
# has a changeset), the PR-time half of gate 4 (a platform major touches breaking-changes.mdx),
# the no-hand-edited-versions rule, the root/platform version invariant, and the Renovate
# changeset writer that replaced qadam-version-bump.yml.
#
# Same construction as test-version-tag-gate.sh: real throwaway git repositories, every accept
# case paired with a reject case that differs in one thing, and an UNKNOWN block asserting that an
# unmeasurable range fails instead of passing. Node only, no install.
#
#   tools/ci/test-changesets-gate.sh

set -uo pipefail

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'
unset GITHUB_HEAD_REF GITHUB_BASE_REF PR_BASE_SHA PR_HEAD_SHA

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="${here}/check-changesets.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CEILING_DIRECTORIES="$tmp"

pass=0
fail=0
last_out=''

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do printf '        %s\n' "$line"; done
  printf '        --- gate output ---\n'
  printf '%s\n' "$last_out" | sed 's/^/        | /'
}

ok() { pass=$((pass + 1)); }

# --- fixture helpers -------------------------------------------------------

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# new_repo <name> — a miniature of this monorepo: a root manifest whose version agrees with
# packages/platform, shared, the framework that bundles it, two qadams, an ignored private app, and
# a changesets config. The
# base commit is tagged `base` so every case can diff base...HEAD like a pull request.
new_repo() {
  local dir="${tmp}/$1"
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config commit.gpgsign false
  write "$dir/package.json" '{ "name": "qadam-flow", "version": "2.0.0", "private": true, "workspaces": ["packages/shared", "packages/platform", "packages/web", "packages/qadams/framework", "packages/qadams/core/*"] }'
  write "$dir/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.0.0", "private": true }'
  write "$dir/packages/shared/package.json" '{ "name": "@aiqadam/shared", "version": "0.1.0" }'
  write "$dir/packages/shared/src/index.ts" 'export const a = 1'
  write "$dir/packages/qadams/framework/package.json" '{ "name": "@aiqadam/qadams-framework", "version": "0.36.0", "dependencies": { "@aiqadam/shared": "workspace:*", "zod": "4.0.0" } }'
  write "$dir/packages/qadams/framework/src/index.ts" 'export const f = 1'
  write "$dir/packages/web/package.json" '{ "name": "web", "version": "0.0.1", "private": true }'
  write "$dir/packages/web/src/main.ts" 'export const w = 1'
  write "$dir/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.0" } }'
  write "$dir/packages/qadams/core/tables/src/index.ts" 'export const t = 1'
  write "$dir/packages/qadams/core/tables/test/index.test.ts" 'test'
  write "$dir/packages/qadams/core/slack/package.json" '{ "name": "@aiqadam/qadam-slack", "version": "1.2.0" }'
  write "$dir/packages/qadams/core/slack/src/index.ts" 'export const s = 1'
  write "$dir/.changeset/config.json" '{ "baseBranch": "main", "privatePackages": { "version": true, "tag": false }, "ignore": ["web"] }'
  write "$dir/.changeset/README.md" '# Changesets'
  write "$dir/docs/install/configuration/breaking-changes.mdx" '## Unreleased'
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
  git -C "$dir" tag base
  printf '%s\n' "$dir"
}

commit_all() { git -C "$1" add -A && git -C "$1" commit -q -m "${2:-change}"; }

# set_platform <dir> <version> — the root package.json and packages/platform at <version>, as the
# release PR's version script leaves them.
set_platform() {
  write "$1/package.json" "{ \"name\": \"qadam-flow\", \"version\": \"$2\", \"private\": true, \"workspaces\": [\"packages/shared\", \"packages/platform\", \"packages/web\", \"packages/qadams/framework\", \"packages/qadams/core/*\"] }"
  write "$1/packages/platform/package.json" "{ \"name\": \"@aiqadam/platform\", \"version\": \"$2\", \"private\": true }"
}

PLATFORM_MAJOR=$'---\n"@aiqadam/platform": major\n---\n\nThe first release under ADR-0001.'

changeset() { write "$1/.changeset/$2.md" "$3"; }

# run_gate <dir> [env assignments...]
run_gate() {
  local dir="$1" rc
  shift
  last_out="$(cd "$dir" && env PR_BASE_SHA=base PR_HEAD_SHA=HEAD "$@" timeout 60 node "$gate" 2>&1)"
  rc=$?
  return "$rc"
}

# expect <want-rc> <label> <dir> <needle> [env...]
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

echo "== ACCEPT =="

d="$(new_repo docs-only)"
write "$d/README.md" 'docs'; commit_all "$d"
expect 0 'a change outside every package needs no changeset' "$d" 'OK'

d="$(new_repo src-with-changeset)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
changeset "$d" tables-fix $'---\n"@aiqadam/qadam-tables": patch\n---\n\nFix the thing.'
commit_all "$d"
expect 0 'a src change with a changeset naming the package -> PASS' "$d" 'declared  @aiqadam/qadam-tables: patch'

d="$(new_repo unquoted-name)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
changeset "$d" tables-fix $'---\n@aiqadam/qadam-tables: minor\n---\n\nAdd the thing.'
commit_all "$d"
expect 0 'an unquoted package name is valid YAML and accepted' "$d" 'OK'

d="$(new_repo test-only)"
write "$d/packages/qadams/core/tables/test/index.test.ts" 'test 2'; commit_all "$d"
expect 0 'a change under test/ only is not a src change' "$d" 'OK'

d="$(new_repo ignored-package)"
write "$d/packages/web/src/main.ts" 'export const w = 2'; commit_all "$d"
expect 0 'an ignored package needs no changeset' "$d" 'OK'

d="$(new_repo release-branch)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.2", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.0" } }'
write "$d/package.json" '{ "name": "qadam-flow", "version": "2.1.0", "private": true, "workspaces": ["packages/shared", "packages/platform", "packages/web", "packages/qadams/framework", "packages/qadams/core/*"] }'
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.1.0", "private": true }'
commit_all "$d"
expect 0 'the release PR (changeset-release/*) may raise versions' "$d" 'OK' GITHUB_HEAD_REF=changeset-release/main

d="$(new_repo platform-major-documented)"
changeset "$d" platform $'---\n"@aiqadam/platform": major\n---\n\nAP_FOO is now required.'
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\nAP_FOO is now required.'
commit_all "$d"
expect 0 'a platform major with a breaking-changes.mdx edit -> PASS' "$d" 'declared  @aiqadam/platform: major'

d="$(new_repo dependency-with-changeset)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.13" } }'
changeset "$d" deps $'---\n"@aiqadam/qadam-tables": patch\n---\n\nUpdate dayjs.'
commit_all "$d"
expect 0 'a dependency change with a changeset -> PASS' "$d" 'OK'

d="$(new_repo shared-removal-only)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "dayjs": "1.11.0" } }'
commit_all "$d"
expect 0 'removing the private @aiqadam/shared alone needs no changeset (ADR-0001, #799)' "$d" 'OK'

d="$(new_repo new-package-with-changeset)"
write "$d/packages/qadams/core/new/package.json" '{ "name": "@aiqadam/qadam-new", "version": "0.0.1" }'
write "$d/packages/qadams/core/new/src/index.ts" 'export const n = 1'
changeset "$d" new $'---\n"@aiqadam/qadam-new": patch\n---\n\nNew qadam.'
commit_all "$d"
expect 0 'a new package with a changeset -> PASS' "$d" 'OK'

d="$(new_repo shared-src-with-framework-changeset)"
write "$d/packages/shared/src/index.ts" 'export const a = 2'
changeset "$d" shared $'---\n"@aiqadam/shared": patch\n"@aiqadam/qadams-framework": patch\n---\n\nFix a.'
commit_all "$d"
expect 0 'a shared src change naming shared and the framework that bundles it -> PASS' "$d" 'declared  @aiqadam/qadams-framework: patch'

d="$(new_repo framework-src-alone)"
write "$d/packages/qadams/framework/src/index.ts" 'export const f = 2'
changeset "$d" framework $'---\n"@aiqadam/qadams-framework": patch\n---\n\nFix f.'
commit_all "$d"
expect 0 'a framework change does not demand a shared changeset (the mapping runs one way) -> PASS' "$d" 'OK'

# The #798 realignment: the tree says 2.0.0 (#326), the newest tag is v1.1.0, and ADR-0001 says the
# root holds the last released version. Every reject case below differs from this one in one thing.
d="$(new_repo realign)"
git -C "$d" tag v1.1.0 base
set_platform "$d" 1.1.0
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0 is the first release under ADR-0001.'
commit_all "$d"
expect 0 'realigning root + platform to the last release tag, with a pending major back to 2.0.0 -> PASS' "$d" 'realigned package.json: 2.0.0 -> 1.1.0, the last release tag v1.1.0; the pending platform changesets take the next release to 2.0.0'
expect 0 'the platform package is realigned with the root -> PASS' "$d" 'realigned packages/platform/package.json: 2.0.0 -> 1.1.0'

d="$(new_repo realign-pending-on-base)"
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"; git -C "$d" tag -f base >/dev/null; git -C "$d" tag v1.1.0 base
set_platform "$d" 1.1.0
commit_all "$d"
expect 0 'the platform changeset that re-reaches the base may already be pending on main -> PASS' "$d" 'next release to 2.0.0'

d="$(new_repo realign-ignores-prerelease-tags)"
git -C "$d" tag v1.1.0 base; git -C "$d" tag v2.0.0-rc.1 base
set_platform "$d" 1.1.0
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"
expect 0 'a prerelease tag is not a release the root can be realigned to, nor one that blocks it -> PASS' "$d" 'the last release tag v1.1.0'

echo "== REJECT =="

d="$(new_repo realign-no-changeset)"
git -C "$d" tag v1.1.0 base
set_platform "$d" 1.1.0
commit_all "$d"
expect 1 'realigning without a pending platform changeset would hand out a lower next release -> FAIL' "$d" 'take the platform from 1.1.0 only to 1.1.0, below the 2.0.0 the base held'

d="$(new_repo realign-minor-short)"
git -C "$d" tag v1.1.0 base
set_platform "$d" 1.1.0
changeset "$d" platform $'---\n"@aiqadam/platform": minor\n---\n\nNew capability.'
commit_all "$d"
expect 1 'a pending minor reaches only 1.2.0, below the 2.0.0 already claimed -> FAIL' "$d" 'only to 1.2.0'

d="$(new_repo realign-older-tag)"
git -C "$d" tag v1.0.0 base; git -C "$d" tag v1.1.0 base
set_platform "$d" 1.0.0
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"
expect 1 'realigning to a release tag that is not the newest one -> FAIL' "$d" '1.0.0 is not the last release tag v1.1.0'

d="$(new_repo realign-unreachable-tag)"
git -C "$d" checkout -q -b side; write "$d/side.txt" 'side'; commit_all "$d"; git -C "$d" tag v1.1.0; git -C "$d" checkout -q main
set_platform "$d" 1.1.0
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"
expect 1 'a release tag not reachable from the head does not count -> FAIL' "$d" 'no vX.Y.Z release tag is reachable'

d="$(new_repo realign-platform-split)"
git -C "$d" tag v1.1.0 base
set_platform "$d" 1.1.0
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "1.2.0", "private": true }'
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"
expect 1 'the root realigns to the tag while the platform package gets another version -> FAIL' "$d" 'root package.json is 1.1.0 but packages/platform/package.json is 1.2.0'

d="$(new_repo realign-platform-only)"
git -C "$d" tag v1.1.0 base
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "1.1.0", "private": true }'
changeset "$d" platform "$PLATFORM_MAJOR"
write "$d/docs/install/configuration/breaking-changes.mdx" $'## Unreleased\n\n2.0.0.'
commit_all "$d"
expect 1 'realigning the platform package without the root is a hand edit -> FAIL' "$d" 'packages/platform/package.json: "version" was edited by hand'

d="$(new_repo src-no-changeset)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'; commit_all "$d"
expect 1 'a src change with no changeset -> FAIL' "$d" '@aiqadam/qadam-tables (packages/qadams/core/tables) has no changeset'

d="$(new_repo wrong-package)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
changeset "$d" slack $'---\n"@aiqadam/qadam-slack": patch\n---\n\nFix slack.'
commit_all "$d"
expect 1 'a changeset for a different package does not cover the change -> FAIL' "$d" '@aiqadam/qadam-tables (packages/qadams/core/tables) has no changeset'

d="$(new_repo empty-changeset)"
write "$d/packages/shared/src/index.ts" 'export const a = 2'
changeset "$d" empty $'---\n---\n'
commit_all "$d"
expect 1 'an empty changeset does not cover a src change -> FAIL' "$d" '@aiqadam/shared (packages/shared) has no changeset'

d="$(new_repo stale-changeset-on-main)"
changeset "$d" pending $'---\n"@aiqadam/qadam-tables": patch\n---\n\nEarlier PR.'
commit_all "$d" 'earlier PR'; git -C "$d" tag -f base >/dev/null
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 3'; commit_all "$d"
expect 1 'a changeset already on main does not cover a new PR -> FAIL' "$d" 'has no changeset'

d="$(new_repo dependency-no-changeset)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.13" } }'
commit_all "$d"
expect 1 'a dependency change with no changeset -> FAIL' "$d" 'dependencies changed'

d="$(new_repo shared-removal-plus-other-change)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "dayjs": "1.11.13" } }'
commit_all "$d"
expect 1 'removing shared does not hide another dependency change in the same diff -> FAIL' "$d" 'dependencies changed'

d="$(new_repo shared-spec-change)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/shared": "0.1.0", "dayjs": "1.11.0" } }'
commit_all "$d"
expect 1 'changing the shared spec, rather than removing it, still needs a changeset -> FAIL' "$d" 'dependencies changed'

d="$(new_repo shared-removal-with-src-change)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "dayjs": "1.11.0" } }'
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
commit_all "$d"
expect 1 'a src change still needs a changeset even when shared was also removed -> FAIL' "$d" 'src changed'

d="$(new_repo shared-src-without-framework)"
write "$d/packages/shared/src/index.ts" 'export const a = 2'
changeset "$d" shared $'---\n"@aiqadam/shared": minor\n---\n\nChange a.'
commit_all "$d"
expect 1 'a shared src change with no framework changeset -> FAIL: the framework tarball vendors it' "$d" '@aiqadam/qadams-framework (packages/qadams/framework) has no changeset in this PR — bundles @aiqadam/shared, whose src changed'

d="$(new_repo shared-dependency-without-framework)"
write "$d/packages/shared/package.json" '{ "name": "@aiqadam/shared", "version": "0.1.0", "dependencies": { "dayjs": "1.11.13" } }'
changeset "$d" shared $'---\n"@aiqadam/shared": patch\n---\n\nUpdate dayjs.'
commit_all "$d"
expect 1 'a shared dependency change with no framework changeset -> FAIL: the framework manifest carries it' "$d" 'bundles @aiqadam/shared, whose dependencies changed'

d="$(new_repo shared-removal-from-framework)"
write "$d/packages/qadams/framework/package.json" '{ "name": "@aiqadam/qadams-framework", "version": "0.36.0", "dependencies": { "zod": "4.0.0" } }'
commit_all "$d"
expect 1 'the shared-removal exemption covers qadams only: dropping it from the framework -> FAIL' "$d" '@aiqadam/qadams-framework (packages/qadams/framework) has no changeset in this PR — dependencies changed'

d="$(new_repo new-package-no-changeset)"
write "$d/packages/qadams/core/new/package.json" '{ "name": "@aiqadam/qadam-new", "version": "0.0.1" }'
write "$d/packages/qadams/core/new/src/index.ts" 'export const n = 1'
commit_all "$d"
expect 1 'a new package with src and no changeset -> FAIL' "$d" '@aiqadam/qadam-new'

d="$(new_repo hand-bump)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.2", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.0" } }'
changeset "$d" tables $'---\n"@aiqadam/qadam-tables": patch\n---\n\nFix.'
commit_all "$d"
expect 1 'a hand-edited package version outside the release PR -> FAIL' "$d" 'was edited by hand'

d="$(new_repo hand-bump-other-branch)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.2", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.0" } }'
commit_all "$d"
expect 1 'the release-branch exemption is by branch, not by anything else -> FAIL' "$d" 'was edited by hand' GITHUB_HEAD_REF=feature/release

d="$(new_repo root-hand-bump)"
write "$d/package.json" '{ "name": "qadam-flow", "version": "2.1.0", "private": true, "workspaces": ["packages/shared", "packages/platform", "packages/web", "packages/qadams/framework", "packages/qadams/core/*"] }'
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.1.0", "private": true }'
commit_all "$d"
expect 1 'a hand-edited root version -> FAIL' "$d" 'package.json: "version" was edited by hand'

d="$(new_repo root-platform-mismatch)"
write "$d/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.0.1", "private": true }'
commit_all "$d"
expect 1 'root and platform versions disagree -> FAIL' "$d" 'they must agree' GITHUB_HEAD_REF=changeset-release/main

d="$(new_repo unknown-package)"
changeset "$d" typo $'---\n"@aiqadam/qadam-tabels": patch\n---\n\nTypo.'
commit_all "$d"
expect 1 'a changeset naming a package that does not exist -> FAIL' "$d" 'not a package in this workspace'

d="$(new_repo ignored-in-changeset)"
changeset "$d" web $'---\n"web": patch\n---\n\nWeb.'
commit_all "$d"
expect 1 'a changeset naming an ignored package -> FAIL' "$d" 'never versions'

d="$(new_repo bad-level)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
changeset "$d" bad $'---\n"@aiqadam/qadam-tables": breaking\n---\n\nOops.'
commit_all "$d"
expect 1 'a level that is not patch/minor/major/none -> FAIL' "$d" "level 'breaking'"

d="$(new_repo no-front-matter)"
changeset "$d" bad $'"@aiqadam/qadam-tables": patch\n\nNo dashes.'
commit_all "$d"
expect 1 'a changeset with no front matter -> FAIL' "$d" 'no "---" front matter'

d="$(new_repo no-summary)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
changeset "$d" bad $'---\n"@aiqadam/qadam-tables": patch\n---\n'
commit_all "$d"
expect 1 'a changeset with no summary -> FAIL' "$d" 'no summary line'

d="$(new_repo garbage-line)"
changeset "$d" bad $'---\n"@aiqadam/qadam-tables": patch\nthis is not yaml\n---\n\nx'
commit_all "$d"
expect 1 'an unparseable front matter line is a problem, not ignored -> FAIL' "$d" 'cannot parse front matter line'

d="$(new_repo platform-major-undocumented)"
changeset "$d" platform $'---\n"@aiqadam/platform": major\n---\n\nAP_FOO is now required.'
commit_all "$d"
expect 1 'a platform major without a breaking-changes.mdx edit -> FAIL (gate 4)' "$d" 'platform major'

echo "== UNKNOWN =="

d="$(new_repo bad-base)"
write "$d/README.md" 'x'; commit_all "$d"
expect 2 'an unreachable base SHA -> UNKNOWN' "$d" 'UNKNOWN' PR_BASE_SHA=0000000000000000000000000000000000000000

d="$(new_repo no-config)"
git -C "$d" rm -q .changeset/config.json; commit_all "$d"
expect 2 'no .changeset/config.json -> UNKNOWN' "$d" 'config.json is missing'

d="$(new_repo stale-ignore)"
write "$d/.changeset/config.json" '{ "privatePackages": { "version": true }, "ignore": ["web", "gone"] }'
commit_all "$d"
expect 2 'an ignore entry naming no package -> UNKNOWN' "$d" 'ignores packages that do not exist'

d="$(new_repo bad-glob)"
write "$d/package.json" '{ "name": "qadam-flow", "version": "2.0.0", "private": true, "workspaces": ["packages/**"] }'
commit_all "$d"
expect 2 'a workspace glob the gate cannot expand -> UNKNOWN' "$d" 'does not expand it' GITHUB_HEAD_REF=changeset-release/main

echo "== RENOVATE CHANGESET WRITER =="

d="$(new_repo renovate)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/shared": "workspace:*", "dayjs": "1.11.13" } }'
commit_all "$d"
last_out="$(cd "$d" && PR_BASE_SHA=base PR_HEAD_SHA=HEAD GITHUB_HEAD_REF='renovate/dayjs-1.x' node "$gate" --write-renovate-changeset 2>&1)"
if [ -f "$d/.changeset/renovate-dayjs-1-x.md" ] && grep -qF '"@aiqadam/qadam-tables": patch' "$d/.changeset/renovate-dayjs-1-x.md"; then
  ok
else
  fail_case 'the writer produces a patch changeset for the qadam whose dependency moved' "$(ls "$d/.changeset")"
fi
commit_all "$d" 'chore(deps): changeset'
expect 0 'and the gate then passes on that branch' "$d" 'OK'

d="$(new_repo renovate-shared-removal-only)"
write "$d/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "dayjs": "1.11.0" } }'
commit_all "$d"
last_out="$(cd "$d" && PR_BASE_SHA=base PR_HEAD_SHA=HEAD GITHUB_HEAD_REF='renovate/shared-removal' node "$gate" --write-renovate-changeset 2>&1)"
if [ -z "$(ls "$d/.changeset" | grep -v -e config.json -e README.md)" ]; then
  ok
else
  fail_case 'the writer never writes a changeset for the exempt shared removal' "$(ls "$d/.changeset")"
fi

d="$(new_repo renovate-shared-dependency)"
write "$d/packages/shared/package.json" '{ "name": "@aiqadam/shared", "version": "0.1.0", "dependencies": { "dayjs": "1.11.13" } }'
commit_all "$d"
last_out="$(cd "$d" && PR_BASE_SHA=base PR_HEAD_SHA=HEAD GITHUB_HEAD_REF='renovate/shared-dayjs' node "$gate" --write-renovate-changeset 2>&1)"
if grep -qF '"@aiqadam/shared": patch' "$d/.changeset/renovate-shared-dayjs.md" 2>/dev/null && grep -qF '"@aiqadam/qadams-framework": patch' "$d/.changeset/renovate-shared-dayjs.md"; then
  ok
else
  fail_case 'a shared dependency bump gets a changeset naming the framework that ships it too' "$(cat "$d/.changeset/renovate-shared-dayjs.md" 2>&1)"
fi
commit_all "$d" 'chore(deps): changeset'
expect 0 'and the gate then passes on that branch' "$d" 'OK'

d="$(new_repo renovate-src)"
write "$d/packages/qadams/core/tables/src/index.ts" 'export const t = 2'
commit_all "$d"
last_out="$(cd "$d" && PR_BASE_SHA=base PR_HEAD_SHA=HEAD GITHUB_HEAD_REF='renovate/x' node "$gate" --write-renovate-changeset 2>&1)"
if [ -z "$(ls "$d/.changeset" | grep -v -e config.json -e README.md)" ]; then
  ok
else
  fail_case 'the writer never covers a src change — only a dependency change is the bot'"'"'s to declare' "$(ls "$d/.changeset")"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
