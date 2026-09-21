#!/usr/bin/env bash
#
# Regression tests for the workspace:* rewrite the framework-packages publish job depends on
# (`pack-framework-packages` in .github/workflows/_pack-framework-packages.yml,
# tools/scripts/publish-framework-packages.ts).
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
#     range, is refused rather than published;
#   - a caret/tilde range on a REAL (non-workspace:) dependency is refused even when workspace:*
#     entries are present beside it — assertNoSemverRanges has to tolerate workspace:* to be
#     usable on a SOURCE manifest at all (every one of these three always has some), but must
#     not let that tolerance swallow an actual range.
#
# Needs the repo's own pinned ts-node (10.9.1) present in node_modules/.bin, so — like the
# migration-metadata and required-prop-defaults suites next to it — this sits after install in
# _verify.yml rather than with the pure-shell suites above it. Invoked by its absolute
# node_modules/.bin path, never `npx ts-node`: the harness runs with its cwd set to a synthetic
# fixture directory that has its own package.json and no node_modules, so `npx` resolves `npm
# prefix` to the fixture, finds no local ts-node there, and silently fetches an uncontrolled
# `ts-node@^10.9.2` (+ typescript) from the registry instead of using this repo's pinned
# 10.9.1/5.5.4 — reproduced with `npx --no-install`, which fails with "canceled due to missing
# packages". Axios (a transitive dependency of the transform this harness imports) is not
# affected by any of this: Node resolves it from the importing file's own directory regardless
# of cwd, which is why axios-needing code elsewhere in tools/ is fine invoked as `npx ts-node`
# from the repo root — only `npx`'s OWN bin resolution is cwd-sensitive.
#
#   tools/ci/test-publish-workspace-invariants.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
harness="$here/publish-workspace-invariants-harness.ts"
ts_project="$repo_root/tools/tsconfig.tools.json"
ts_node_bin="$repo_root/node_modules/.bin/ts-node"

if [ ! -x "$ts_node_bin" ]; then
  echo "publish workspace-rewrite invariant tests FAILED: $ts_node_bin not found — run bun install first." >&2
  exit 1
fi

pass=0
fail=0

cleanup() {
  [ -n "${root:-}" ] && rm -rf "$root"
  [ -n "${guard_stub:-}" ] && rm -rf "$guard_stub"
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
  out="$(cd "$root" && "$ts_node_bin" --project "$ts_project" "$harness" "$1" "$2" 2>&1)"
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

echo "== assertNoSemverRanges tolerates workspace:* (a different, later-resolved concern) but still catches a real caret/tilde range beside it =="

new_workspace_fixture
write_json "$root/source-package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "pkg-a": "workspace:*", "some-lib": "1.2.3" }
}'
run_harness assert-no-semver-ranges "$root/source-package.json"
expect_status 0 "workspace:* alongside exact versions is not flagged as a range"

new_workspace_fixture
write_json "$root/source-package.json" '{
  "name": "pkg-b",
  "version": "1.0.0",
  "dependencies": { "pkg-a": "workspace:*", "some-lib": "^1.2.3" }
}'
run_harness assert-no-semver-ranges "$root/source-package.json"
expect_status 1 "a caret range on a real dependency is still refused even with workspace:* present"
expect_contains "some-lib" "the error names the offending dependency, not the tolerated workspace:* one"

# The refusal guard on --skip-registry-check. Driven through the real CLI entry point rather than
# the harness, because the mistake it exists to stop is a human adding the flag to an invocation
# that publishes — and because until this case existed, the branch the flag's own comment calls
# load-bearing was executed by no test in a repo whose release paths are already too rarely run.
# The guard is the first thing publishNpmPackage does, so this needs no fixture, no build output
# and no network.
# Behind a stub `npm`, and the third assertion below is that the stub is never called.
# Without it this case would be the one thing in this suite that can reach a real
# `npm publish`: it drives the real CLI with no --pack-to and no --dry-run, so the ONLY thing
# between it and a live publish of @aiqadam/shared is the guard it is testing. A guard
# regression — precisely the event this case exists to catch — would therefore be detected by
# performing the unretractable action it protects against. In CI that 401s (no job here sets
# NPM_TOKEN), but the script is deliberately kept usable by hand, and a maintainer with
# NPM_TOKEN exported would publish for real. Same shape as the stub in
# tools/ci/test-publish-packed-tarballs.sh; `timeout` because a regression would otherwise
# spend ~3 minutes in getLatestPublishedVersion's retry backoff (2+8+32+128 s — it rethrows on
# the fifth attempt before sleeping the last delay), and unbounded if the connection hangs,
# since that axios call sets no timeout of its own.
guard_stub="$(mktemp -d)"
mkdir -p "$guard_stub/bin"
cat > "$guard_stub/bin/npm" <<'GUARD_STUB'
#!/usr/bin/env bash
echo "npm $*" >> "$NPM_CALL_LOG"
exit 0
GUARD_STUB
chmod +x "$guard_stub/bin/npm"
NPM_CALL_LOG="$guard_stub/npm-calls.log"
export NPM_CALL_LOG
: > "$NPM_CALL_LOG"

# Positive control for the call-log assertion further down. An empty log is equally consistent
# with "the guard refused before npm" and with "the stub was never on PATH and the real npm
# ran" — the second being the state that assertion exists to rule out, so it has to be excluded
# separately rather than inferred from the log being empty.
resolved_npm="$(PATH="$guard_stub/bin:$PATH" command -v npm || true)"
if [ "$resolved_npm" = "$guard_stub/bin/npm" ]; then
  pass=$((pass + 1)); echo "ok: the stub npm is what the guard case would reach"
else
  fail=$((fail + 1)); echo "FAIL: stub not on PATH — npm resolves to ${resolved_npm:-nothing}, so the call-log assertion is vacuous"
fi

guard_out="$(cd "$repo_root" && PATH="$guard_stub/bin:$PATH" timeout 60 "$ts_node_bin" --project "$ts_project" \
  tools/scripts/publish-framework-packages.ts --skip-registry-check 2>&1)"
guard_status=$?
# Both assertions require the guard's own message. Asserting only "exited non-zero" or only
# "no registry line" would pass with the guard deleted — verified by mutation: without it the run
# still fails, just later and for another reason, so those two on their own prove nothing.
case "$guard_out" in
  *"skipRegistryCheck is only valid with packDestination or dryRun"*) guard_refused=yes ;;
  *) guard_refused=no ;;
esac

if [ "$guard_refused" = yes ] && [ "$guard_status" -ne 0 ]; then
  pass=$((pass + 1)); echo "ok: --skip-registry-check without a pack destination is refused, by name"
else
  fail=$((fail + 1)); echo "FAIL: expected the skipRegistryCheck refusal, got status ${guard_status}: ${guard_out}"
fi

if [ -s "$NPM_CALL_LOG" ]; then
  fail=$((fail + 1)); echo "FAIL: the guard case invoked npm — a regression here would publish for real: $(cat "$NPM_CALL_LOG")"
else
  pass=$((pass + 1)); echo "ok: the guard case never reaches npm at all"
fi

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "publish workspace-rewrite invariant tests FAILED."
  exit 1
fi
echo "publish workspace-rewrite invariant tests passed."
