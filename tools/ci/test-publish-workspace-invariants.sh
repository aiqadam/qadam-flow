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
#     not let that tolerance swallow an actual range;
#   - a private workspace package (`@aiqadam/shared`, #799) is published only inside the package
#     configured to bundle it, with its imports rewritten and its used dependencies carried over —
#     and any other manifest or emitted file that still reaches one is refused.
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
  # $1 = mode, $2 = arg, $3 = optional extra arg (stage: the bundled-private-dependencies map as JSON)
  # TMPDIR inside the fixture, so the suite can see whether a staging directory outlived its run.
  mkdir -p "$root/tmp"
  out="$(cd "$root" && TMPDIR="$root/tmp" "$ts_node_bin" --project "$ts_project" "$harness" "$@" 2>&1)"
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

echo "== a private workspace package is bundled into the package configured to carry it, and nothing else may reach one (#799) =="

# pkg-a plays @aiqadam/shared (private, built), pkg-b plays qadams-framework (its dist already
# through prepareQadamDistForPublish, so pkg-a is an exact version). The comment line in pkg-a's
# build is the shape of records.dto.js that once read as a dependency named "it was already there".
new_bundling_fixture() {
  new_workspace_fixture
  write_json "$root/pkg-a/package.json" '{
  "name": "pkg-a", "version": "9.9.9", "private": true,
  "main": "./dist/src/index.js", "types": "./dist/src/index.d.ts",
  "dependencies": { "some-lib": "1.0.0", "tslib": "2.6.2", "unused-lib": "3.0.0" }
}'
  mkdir -p "$root/pkg-a/dist/src/lib"
  printf '%s\n' '"use strict";' 'const some = require("some-lib");' 'const tslib = require("tslib");' '// tells "I created it" from "it was already there"' 'exports.A = require("./lib/a").A;' > "$root/pkg-a/dist/src/index.js"
  printf '%s\n' "import { z } from 'some-lib';" "export { A } from './lib/a';" 'export type B = z.Thing;' > "$root/pkg-a/dist/src/index.d.ts"
  printf '%s\n' '"use strict";' 'exports.A = "a";' > "$root/pkg-a/dist/src/lib/a.js"
  printf '%s\n' 'export declare const A = "a";' > "$root/pkg-a/dist/src/lib/a.d.ts"
  write_json "$root/pkg-b/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "pkg-a": "workspace:*" } }'
  write_json "$root/pkg-b/dist/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "pkg-a": "9.9.9", "other-lib": "1.2.3" } }'
  mkdir -p "$root/pkg-b/dist/src/lib"
  printf '%s\n' '"use strict";' 'const pkg_a_1 = require("pkg-a");' 'exports.A = pkg_a_1.A;' > "$root/pkg-b/dist/src/index.js"
  printf '%s\n' "export { A } from 'pkg-a';" 'export type B = import("pkg-a").B;' > "$root/pkg-b/dist/src/lib/types.d.ts"
}

staged_dir() { printf '%s\n' "$out" | sed -n 's/^STAGED //p'; }
inspect_dir() { printf '%s\n' "$out" | sed -n 's/^INSPECT //p'; }

expect_no_staging_left() {
  # $1 = description
  if [ -z "$(find "$root/tmp" -maxdepth 1 -name 'qadam-flow-publish-stage-*' 2>/dev/null)" ]; then ok; else bad "$1 — a staging directory was left behind: $(ls "$root/tmp")"; fi
}

expect_file_contains() {
  # $1 = file, $2 = needle, $3 = description
  if grep -qF -- "$2" "$1" 2>/dev/null; then ok; else bad "$3 — '$2' not in $1"; fi
}

new_bundling_fixture
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 0 "a configured private dependency is bundled"
staged="$(staged_dir)"
if [ -n "$staged" ] && [ "$staged" != "$root/pkg-b/dist" ]; then ok; else bad "expected a staging directory distinct from dist, got '$staged'"; fi
if [ -n "$staged" ] && [ ! -e "$staged" ]; then ok; else bad "the staging directory '$staged' still exists after it was packed"; fi
expect_no_staging_left "a successful stage removes its staging directory"
staged="$(inspect_dir)"
if [ -z "$(json_field "$staged/package.json" "dependencies.pkg-a")" ]; then ok; else bad "the staged manifest still depends on the private pkg-a"; fi
if [ "$(json_field "$staged/package.json" "dependencies.some-lib")" = "1.0.0" ]; then ok; else bad "the bundled code's own dependency some-lib@1.0.0 was not carried over"; fi
if [ "$(json_field "$staged/package.json" "dependencies.other-lib")" = "1.2.3" ]; then ok; else bad "pkg-b's own dependency was lost"; fi
if [ -z "$(json_field "$staged/package.json" "dependencies.unused-lib")" ]; then ok; else bad "a dependency the bundled code never imports was carried over"; fi
expect_file_contains "$staged/vendor/pkg-a/index.js" 'require("some-lib")' "the vendored build is the private package's own build output"
expect_file_contains "$staged/src/index.js" 'require("../vendor/pkg-a/index.js")' "a require of the private package points at the vendored copy"
expect_file_contains "$staged/src/lib/types.d.ts" "from '../../vendor/pkg-a/index.js'" "a declaration import of the private package points at the vendored copy"
expect_file_contains "$staged/src/lib/types.d.ts" 'import("../../vendor/pkg-a/index.js")' "an import() type of the private package points at the vendored copy"
expect_file_contains "$root/pkg-b/dist/src/index.js" 'require("pkg-a")' "the workspace dist is never rewritten — the API and engine keep loading the workspace copy"

new_bundling_fixture
run_harness stage "$root/pkg-b/dist"
expect_status 1 "a package not configured to bundle a private dependency is refused"
expect_contains "dependencies.pkg-a" "the error names the private dependency"
expect_contains "src/index.js imports pkg-a" "the error names the file that imports it"

new_bundling_fixture
write_json "$root/pkg-b/dist/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "other-lib": "1.2.3" } }'
rm "$root/pkg-b/dist/src/index.js"
run_harness stage "$root/pkg-b/dist"
expect_status 1 "a private package reached only through declaration emit is refused"
expect_contains "src/lib/types.d.ts imports pkg-a" "the error names the declaration file"

new_bundling_fixture
write_json "$root/pkg-b/dist/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "other-lib": "1.2.3" } }'
rm "$root/pkg-b/dist/src/lib/types.d.ts"
printf '%s\n' '"use strict";' 'const channel = "pkg-a";' 'const apiPath = "pkg-a/v2";' > "$root/pkg-b/dist/src/index.js"
run_harness stage "$root/pkg-b/dist"
expect_status 0 "a quoted string that merely equals a private package's name is not an import"
expect_not_contains "imports pkg-a" "the string literal is not reported as a dependency"

new_bundling_fixture
printf '%s\n' 'require("ghost-lib");' >> "$root/pkg-a/dist/src/lib/a.js"
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "bundled code that needs a dependency its package does not declare is refused"
expect_contains "ghost-lib" "the error names the undeclared dependency"
expect_no_staging_left "a stage that fails after copying still removes its staging directory"

new_bundling_fixture
printf '%s\n' 'const deep = require("pkg-a/lib/a");' >> "$root/pkg-b/dist/src/index.js"
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "a subpath import of the private package is refused rather than left pointing at it"
expect_contains "subpath" "the error names the reason"

new_bundling_fixture
write_json "$root/pkg-b/dist/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "pkg-a": "9.9.9", "some-lib": "2.0.0" } }'
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "two versions of one dependency between the package and its bundled code are refused"
expect_contains "some-lib" "the error names the conflicting dependency"

new_bundling_fixture
write_json "$root/pkg-b/dist/package.json" '{ "name": "pkg-b", "version": "1.0.0", "dependencies": { "other-lib": "1.2.3" }, "devDependencies": { "pkg-a": "9.9.9", "vitest": "4.1.11" } }'
rm "$root/pkg-b/dist/src/index.js" "$root/pkg-b/dist/src/lib/types.d.ts"
run_harness stage "$root/pkg-b/dist"
expect_status 0 "a devDependency on a private package does not block the publish"
if [ "$(staged_dir)" = "$root/pkg-b/dist" ] && [ -d "$root/pkg-b/dist" ]; then ok; else bad "a package that bundles nothing is packed from dist itself, and dist is never removed — got '$(staged_dir)'"; fi
if [ -z "$(json_field "$root/pkg-b/dist/package.json" "devDependencies.pkg-a")" ]; then ok; else bad "the published manifest still names the private package as a devDependency"; fi
if [ "$(json_field "$root/pkg-b/dist/package.json" "devDependencies.vitest")" = "4.1.11" ]; then ok; else bad "other devDependencies were dropped"; fi

new_bundling_fixture
printf '%s\n' 'const apiPath = "pkg-a/v2";' '// see "pkg-a/lib/a" for the shape' >> "$root/pkg-b/dist/src/index.js"
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 0 "a string literal or comment naming a subpath of the bundled package is not a subpath import"
expect_not_contains "subpath" "the subpath guard reads import specifiers, not every quoted string"

echo "== the private package's main/types must be files inside its own directory =="

bundling_fixture_with_pkg_a_entry() {
  # $1 = main, $2 = types (JSON values, so an absent field can be passed as null)
  new_bundling_fixture
  node -e "
    const fs = require('fs');
    const path = '$root/pkg-a/package.json';
    const manifest = JSON.parse(fs.readFileSync(path));
    const set = (key, value) => { if (value === null) { delete manifest[key]; } else { manifest[key] = value; } };
    set('main', $1);
    set('types', $2);
    fs.writeFileSync(path, JSON.stringify(manifest));
  "
}

bundling_fixture_with_pkg_a_entry null '"./dist/src/index.d.ts"'
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "a private package with no main is refused"
expect_contains 'declares no "main"' "the error names the missing field"
expect_no_staging_left "a refused main leaves no staging directory"

bundling_fixture_with_pkg_a_entry '"./dist/src/index.js"' '""'
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "an empty types is refused, not read as the package directory itself"
expect_contains 'declares no "types"' "the error names the empty field"

bundling_fixture_with_pkg_a_entry '"../pkg-b/dist/src/index.js"' '"./dist/src/index.d.ts"'
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "a main that resolves outside the private package's directory is refused"
expect_contains "resolves outside its package directory" "the error names the reason"

bundling_fixture_with_pkg_a_entry '"./dist/src"' '"./dist/src/index.d.ts"'
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "a main that names a directory is refused"
expect_contains "is not a file" "the error names the reason"

bundling_fixture_with_pkg_a_entry '"./index.js"' '"./index.d.ts"'
printf '%s\n' 'exports.A = "a";' > "$root/pkg-a/index.js"
printf '%s\n' 'export declare const A = "a";' > "$root/pkg-a/index.d.ts"
run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 1 "main/types at the private package's root are refused — vendoring it would ship its sources and manifest"
expect_contains "package root" "the error names the reason"

echo "== the workspace map is read from literal directories and <dir>/* only =="

stage_with_workspaces() {
  # $1 = the root manifest's "workspaces" value as JSON, or "absent"
  new_bundling_fixture
  if [ "$1" = absent ]; then
    write_json "$root/package.json" '{ "name": "fixture-root" }'
  else
    write_json "$root/package.json" "{ \"name\": \"fixture-root\", \"workspaces\": $1 }"
  fi
  run_harness stage "$root/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
}

stage_with_workspaces '["pkg-*"]'
expect_status 1 "a glob that is not <dir>/* is refused, not read as a literal directory"
expect_contains "pkg-*" "the error names the pattern"

stage_with_workspaces '["pkg-a", "**/pkg-b"]'
expect_status 1 "a ** pattern is refused"
expect_contains "**/pkg-b" "the error names the pattern"

stage_with_workspaces '["pkg-a", "pkg-b", "!pkg-c"]'
expect_status 1 "a negated pattern is refused"
expect_contains "!pkg-c" "the error names the pattern"

stage_with_workspaces 'absent'
expect_status 1 "a root manifest with no workspaces is refused — the private-package check would otherwise pass vacuously"
expect_contains 'declares no "workspaces"' "the error names the reason"

stage_with_workspaces '[]'
expect_status 1 "an empty workspaces list is refused"
expect_contains 'declares no "workspaces"' "the error names the reason"

mkdir -p "$root/nested"
mv "$root/pkg-a" "$root/nested/pkg-a"
mv "$root/pkg-b" "$root/nested/pkg-b"
write_json "$root/package.json" '{ "name": "fixture-root", "workspaces": ["nested/*"] }'
run_harness stage "$root/nested/pkg-b/dist" '{"pkg-b":["pkg-a"]}'
expect_status 0 "a <dir>/* pattern is expanded"

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
# tools/ci/test-publish-packed-tarballs.sh; `timeout` because a guard regression would otherwise
# spend ~3 minutes in packagePrePublishChecks' retry backoff (2+8+32+128 s — it rethrows on the
# fifth attempt before sleeping the last delay) before failing, stalling the suite that long.
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

# --- step 1b: the official-qadam leg (#476) -----------------------------------------------
#
# ci.yml's `pack-smoke` deliberately packs only the two framework packages, so the
# qadam-specific half of the pack script is exercised nowhere else on a PR. These cover it.

: > "$NPM_CALL_LOG"
qadam_guard_out="$(cd "$repo_root" && PATH="$guard_stub/bin:$PATH" timeout 60 "$ts_node_bin" --project "$ts_project" \
  tools/scripts/publish-framework-packages.ts --include-qadams 2>&1)"
qadam_guard_status=$?
# By name, for the same reason the skipRegistryCheck case above is: without the guard this run
# still fails eventually, so "exited non-zero" alone would pass with the guard deleted.
case "$qadam_guard_out" in
  *"--include-qadams is only valid with --pack-to or --dry-run"*) qadam_guard_refused=yes ;;
  *) qadam_guard_refused=no ;;
esac

if [ "$qadam_guard_refused" = yes ] && [ "$qadam_guard_status" -ne 0 ]; then
  pass=$((pass + 1)); echo "ok: --include-qadams without a pack destination is refused, by name"
else
  fail=$((fail + 1)); echo "FAIL: expected the includeQadams refusal, got status ${qadam_guard_status}: ${qadam_guard_out}"
fi

if [ -s "$NPM_CALL_LOG" ]; then
  fail=$((fail + 1)); echo "FAIL: the --include-qadams guard case invoked npm — 238 unretractable publishes from the packing process: $(cat "$NPM_CALL_LOG")"
else
  pass=$((pass + 1)); echo "ok: the --include-qadams guard case never reaches npm at all"
fi

# The expected count is derived with `find`, not hardcoded and not read back out of the module
# under test: "238 == 238" against a constant would survive the traversal returning the wrong
# SET at the right size, and reading it from the same code makes the assertion circular.
expected_qadam_count="$(cd "$repo_root" && find packages/qadams/core packages/qadams/community \
  -mindepth 2 -maxdepth 2 -name package.json 2>/dev/null | grep -c . || true)"
if [ "${expected_qadam_count:-0}" -lt 2 ]; then
  fail=$((fail + 1)); echo "FAIL: found ${expected_qadam_count:-0} qadam package.json files on disk — the assertions below would be vacuous"
else
  pass=$((pass + 1)); echo "ok: ${expected_qadam_count} official qadams on disk to compare against"
fi

# `tail -1` because ts-node's own diagnostics (and anything the imported modules log) share
# stdout; the probe prints its JSON last and nothing after it.
qadam_paths_out="$(cd "$repo_root" && timeout 180 "$ts_node_bin" --project "$ts_project" -e '
const { findOfficialQadamPackagePaths } = require("./tools/scripts/utils/qadam-publish-paths")
findOfficialQadamPackagePaths().then((paths) => {
  console.log(JSON.stringify({
    count: paths.length,
    frameworkLeaked: paths.filter((p) => p === "packages/qadams/framework" || p === "packages/qadams/common").length,
    customLeaked: paths.filter((p) => p.startsWith("packages/qadams/custom")).length,
    sorted: JSON.stringify(paths) === JSON.stringify([...paths].sort()),
  }))
}).catch((err) => { console.log(JSON.stringify({ error: String(err) })); process.exitCode = 1 })' 2>&1 | tail -1)"

read_probe() { printf '%s' "$qadam_paths_out" | sed -n "s/.*\"$1\":\\([^,}]*\\).*/\\1/p"; }

check_probe() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1)); echo "ok: $1"
  else
    fail=$((fail + 1)); echo "FAIL: $1 — expected '$3', got '$2' (probe output: ${qadam_paths_out})"
  fi
}

check_probe "findOfficialQadamPackagePaths returns every official qadam and no more" \
  "$(read_probe count)" "$expected_qadam_count"
# The failure this one exists for: packing a framework package a second time under the qadam
# sweep puts two tarballs for the same name@version in one manifest, and the second 403s after
# the first has already uploaded — a partial publish that reads as a build failure.
check_probe "the framework packages do not leak into the qadam sweep" \
  "$(read_probe frameworkLeaked)" "0"
# packages/qadams/custom is where a locally authored qadam lands. Publishing one to the
# @aiqadam scope from a developer's tree is not a thing this pipeline may ever do.
check_probe "packages/qadams/custom does not leak into the qadam sweep" \
  "$(read_probe customLeaked)" "0"
# Filesystem order is not lexical, so without the sort two runs of the same tree produce
# manifests that differ only by shuffling — which makes diffing two publish artifacts useless.
check_probe "the returned paths are sorted, so the manifest is stable between runs" \
  "$(read_probe sorted)" "true"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "publish workspace-rewrite invariant tests FAILED."
  exit 1
fi
echo "publish workspace-rewrite invariant tests passed."
