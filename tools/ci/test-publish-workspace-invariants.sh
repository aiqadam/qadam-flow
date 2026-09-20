#!/usr/bin/env bash
#
# Regression tests for the workspace:* rewrite the framework-packages publish job depends on
# (release.yml's `publish-framework-packages` job, tools/scripts/publish-framework-packages.ts).
# That job's whole thesis — recorded in its own header comment — is "do not trust the
# toolchain's own workspace:* rewrite", because bun's native one reads a version bun.lock does
# not reliably keep in sync with the dependency's own package.json (measured on this repo: a
# `packages/shared/package.json` version bump with no dependency change left bun.lock quoting
# the prior version through both `bun install` and `bun install --force`). These pin the
# invariants a regression in the custom transform would violate silently, since a wrong
# version written into a published tarball is not something any later step here catches:
#
#   - a workspace:* dependency resolves to the DEPENDENCY'S OWN live package.json version;
#   - the SOURCE tree is never written to, including when resolution fails partway through;
#   - an artifact still carrying an unresolved workspace: dependency, or a non-exact semver
#     range, is refused rather than published.
#
# Needs ts-node and the transform's own dependencies (axios, via package-pre-publish-checks.ts)
# from node_modules, so — like the migration-metadata and required-prop-defaults suites next to
# it — this sits after install in _verify.yml rather than with the pure-shell suites above it.
#
#   tools/ci/test-publish-workspace-invariants.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
harness="$here/publish-workspace-invariants-harness.ts"
ts_project="$repo_root/tools/tsconfig.tools.json"

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

write_json() {
  # $1 = path, $2 = content
  mkdir -p "$(dirname "$1")"
  printf '%s' "$2" > "$1"
}

new_workspace_fixture() {
  cleanup
  root="$(mktemp -d)"
  write_json "$root/package.json" '{
  "name": "fixture-root",
  "workspaces": ["pkg-a", "pkg-b"]
}'
}

run_harness() {
  # $1 = mode, $2 = arg
  out="$(cd "$root" && npx ts-node --project "$ts_project" "$harness" "$1" "$2" 2>&1)"
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

json_field() {
  # $1 = path, $2 = dotted "field.subfield" (max one level of dependency-object nesting)
  node -e "
    const fs = require('fs');
    const parts = '$2'.split('.');
    let v = JSON.parse(fs.readFileSync('$1'));
    for (const p of parts) { v = v && v[p]; }
    console.log(v === undefined ? '' : v);
  "
}

echo "== a workspace:* dependency resolves to the dependency's OWN live package.json version =="

new_workspace_fixture
write_json "$root/pkg-a/package.json" '{ "name": "pkg-a", "version": "9.9.9" }'
write_json "$root/pkg-b/package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "pkg-a": "workspace:*" }
}'
mkdir -p "$root/pkg-b/dist"

run_harness prepare "$root/pkg-b"
expect_status 0 "a resolvable workspace dependency prepares cleanly"

resolved="$(json_field "$root/pkg-b/dist/package.json" "dependencies.pkg-a")"
if [ "$resolved" = "9.9.9" ]; then ok; else bad "expected dist dependency to resolve to 9.9.9, got '$resolved'"; fi

echo "== the SOURCE package.json is never rewritten =="

source_dep="$(json_field "$root/pkg-b/package.json" "dependencies.pkg-a")"
if [ "$source_dep" = "workspace:*" ]; then ok; else bad "expected the SOURCE package.json to still say workspace:*, got '$source_dep'"; fi

echo "== an unresolvable workspace dependency aborts, and still never touches the source tree =="

new_workspace_fixture
write_json "$root/pkg-a/package.json" '{ "name": "pkg-a", "version": "9.9.9" }'
write_json "$root/pkg-b/package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "pkg-missing": "workspace:*" }
}'
mkdir -p "$root/pkg-b/dist"

run_harness prepare "$root/pkg-b"
expect_status 1 "a workspace dependency absent from the workspace map must abort, not publish a broken reference"
expect_contains "pkg-missing" "the error names the unresolved dependency"

source_dep="$(json_field "$root/pkg-b/package.json" "dependencies.pkg-missing")"
if [ "$source_dep" = "workspace:*" ]; then ok; else bad "a failed prepare must never rewrite the SOURCE package.json, got '$source_dep'"; fi

echo "== an artifact still carrying workspace:* is refused, not published =="

new_workspace_fixture
write_json "$root/dist-package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "pkg-a": "workspace:*" }
}'
run_harness assert-no-workspace-deps "$root/dist-package.json"
expect_status 1 "an unresolved workspace: dependency in the artifact to be published must be refused"
expect_contains "unresolved workspace dependencies" "the error names the reason"

echo "== a non-exact semver range in the artifact to be published is refused, an exact one passes =="

new_workspace_fixture
write_json "$root/dist-package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "some-lib": "^1.2.3" }
}'
run_harness assert-no-semver-ranges "$root/dist-package.json"
expect_status 1 "a caret/tilde range in the artifact to be published must be refused"
expect_contains "non-exact versions" "the error names the reason"

new_workspace_fixture
write_json "$root/dist-package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "some-lib": "1.2.3" }
}'
run_harness assert-no-semver-ranges "$root/dist-package.json"
expect_status 0 "an exact version passes"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "publish workspace-rewrite invariant tests FAILED."
  exit 1
fi
echo "publish workspace-rewrite invariant tests passed."
