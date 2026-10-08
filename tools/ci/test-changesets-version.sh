#!/usr/bin/env bash
#
# Tests for the release PR's version step, tools/scripts/changesets/version.mjs, run through the
# repo's real @changesets/cli on a miniature bun workspace (root package.json `workspaces` +
# `bun.lock`, `workspace:*` internal dependencies — the shape that made "does changesets read the
# bun workspaces" an open question in ADR-0001). Pins:
#   - a `"@aiqadam/platform": major` changeset moves the ROOT package.json version (changesets
#     itself cannot version the root);
#   - `workspace:*` ranges are left as they are;
#   - the internal-dependency cascade: a framework release patches every workspace dependent,
#     because `workspace:*` publishes as an exact pin. Asserted, so a config change that silently
#     stops (or widens) the cascade shows up here;
#   - nothing is published and nothing is tagged.
#
#   tools/ci/test-changesets-version.sh

set -uo pipefail

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
script="$repo_root/tools/scripts/changesets/version.mjs"
[ -x "$repo_root/node_modules/.bin/changeset" ] || { echo "changesets version tests FAILED: node_modules/.bin/changeset not found — run bun install first." >&2; exit 1; }

tmp="$(mktemp -d)"
trap '[ -n "${KEEP_TMP:-}" ] || rm -rf "$tmp"' EXIT
export GIT_CEILING_DIRECTORIES="$tmp"

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$3" "$2"; fi
}

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }
version_of() { node -p "require('$1/package.json').version"; }
dep_of() { node -p "require('$1/package.json').dependencies['$2']"; }

new_repo() {
  local dir="$tmp/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config commit.gpgsign false
  write "$dir/package.json" '{ "name": "qadam-flow", "version": "2.0.0", "private": true, "workspaces": ["packages/platform", "packages/shared", "packages/qadams/framework", "packages/qadams/common", "packages/qadams/core/*"] }'
  : > "$dir/bun.lock"
  write "$dir/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.0.0", "private": true }'
  write "$dir/packages/shared/package.json" '{ "name": "@aiqadam/shared", "version": "0.156.0" }'
  write "$dir/packages/qadams/framework/package.json" '{ "name": "@aiqadam/qadams-framework", "version": "0.35.1", "dependencies": { "@aiqadam/shared": "workspace:*" } }'
  write "$dir/packages/qadams/common/package.json" '{ "name": "@aiqadam/qadams-common", "version": "0.17.0", "dependencies": { "@aiqadam/qadams-framework": "workspace:*", "@aiqadam/shared": "workspace:*" } }'
  write "$dir/packages/qadams/core/tables/package.json" '{ "name": "@aiqadam/qadam-tables", "version": "0.5.1", "dependencies": { "@aiqadam/qadams-common": "workspace:*", "@aiqadam/qadams-framework": "workspace:*" } }'
  write "$dir/packages/qadams/core/slack/package.json" '{ "name": "@aiqadam/qadam-slack", "version": "1.2.0", "dependencies": { "@aiqadam/qadams-framework": "workspace:*" } }'
  write "$dir/.changeset/config.json" '{ "changelog": false, "commit": false, "format": false, "access": "public", "baseBranch": "main", "updateInternalDependencies": "patch", "privatePackages": { "version": true, "tag": false }, "ignore": [] }'
  git -C "$dir" add -A && git -C "$dir" commit -q -m base
  printf '%s\n' "$dir"
}

run_version() { (cd "$1" && timeout 120 node "$script" >"$1.log" 2>&1); }

echo "== a platform major moves the root =="
d="$(new_repo platform-major)"
write "$d/.changeset/op.md" $'---\n"@aiqadam/platform": major\n---\n\nOperators must set AP_FOO.'
git -C "$d" add -A && git -C "$d" commit -q -m cs
run_version "$d"; check 'version script exits 0' "$?" 0
check 'platform package raised' "$(version_of "$d/packages/platform")" 3.0.0
check 'root package.json follows the platform' "$(version_of "$d")" 3.0.0
check 'no other package moved' "$(version_of "$d/packages/qadams/core/slack")" 1.2.0
check 'the consumed changeset is deleted' "$(ls "$d/.changeset" | grep -c '\.md$')" 0

echo "== a qadam patch leaves the platform alone =="
d="$(new_repo qadam-patch)"
write "$d/.changeset/fix.md" $'---\n"@aiqadam/qadam-slack": patch\n---\n\nFix.'
git -C "$d" add -A && git -C "$d" commit -q -m cs
run_version "$d"
check 'the qadam is raised' "$(version_of "$d/packages/qadams/core/slack")" 1.2.1
check 'the root is untouched' "$(version_of "$d")" 2.0.0
check 'the SDK is untouched' "$(version_of "$d/packages/qadams/framework")" 0.35.1

echo "== the internal-dependency cascade (workspace:* = exact pin) =="
d="$(new_repo framework-minor)"
write "$d/.changeset/sdk.md" $'---\n"@aiqadam/qadams-framework": minor\n---\n\nNew export.'
git -C "$d" add -A && git -C "$d" commit -q -m cs
run_version "$d"
check 'framework raised at the declared level' "$(version_of "$d/packages/qadams/framework")" 0.36.0
check 'common follows with a patch (#494 deliverable 3)' "$(version_of "$d/packages/qadams/common")" 0.17.1
check 'every qadam depending on the framework is patched too' "$(version_of "$d/packages/qadams/core/slack")" 1.2.1
check '… including through common' "$(version_of "$d/packages/qadams/core/tables")" 0.5.2
check 'shared (a dependency, not a dependent) is untouched' "$(version_of "$d/packages/shared")" 0.156.0
check 'workspace:* is left as it is' "$(dep_of "$d/packages/qadams/core/tables" '@aiqadam/qadams-framework')" 'workspace:*'
check 'the root is untouched' "$(version_of "$d")" 2.0.0

echo "== nothing pending =="
d="$(new_repo nothing)"
run_version "$d"; check 'no changesets exits 0' "$?" 0
check 'and changes nothing' "$(git -C "$d" status --porcelain | wc -l | tr -d ' ')" 0

echo "== never publishes, never tags =="
check 'no tag was created in any fixture' "$(for r in "$tmp"/*/; do git -C "$r" tag; done | wc -l | tr -d ' ')" 0
# The script runs `changeset version` only; `changeset publish` / `changeset tag` must never appear.
if grep -qE "\[ *'(publish|tag)'" "$script"; then
  fail=$((fail + 1)); echo 'FAIL  the version script invokes changeset publish or tag'
else
  pass=$((pass + 1))
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
