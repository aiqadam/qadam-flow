#!/usr/bin/env bash
#
# Fixture tests for gate 8 of ADR-0002, tools/ci/check-framework-support.mjs.
#
# Each fixture is a throwaway git repository holding the few files the gate reads: the framework's
# package.json, versioning.ts (ContextVersion, LATEST_CONTEXT_VERSION and the shim dispatcher), the
# support table, an engine file that calls the dispatcher, the engine's connection resolver (the
# second shim site) and one official qadam. The base commit is the PR base; the working tree is the
# PR head. `--now` pins the date, so every case is deterministic.
#
# The four scenarios #801 names are marked [#801]; the rest pin the edges those four rest on
# (the 12-month boundary, the "two majors" half of the rule, monotonicity in time, and the cases
# where the gate must fail loudly rather than pass having checked nothing).
#
# Run from the "Lint + unit test suite" job (it needs node, git and `typescript` from node_modules).
#
#   tools/ci/test-framework-support-gate.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-framework-support.mjs"

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

# $1 = enum members (e.g. "V1 = '1', V2 = '2',"), $2 = LATEST member, $3 = dispatcher case lines
write_versioning() {
  cat > "$root/packages/qadams/framework/src/lib/context/versioning.ts" <<FIXTURE
export enum ContextVersion {
    $1
}
export const LATEST_CONTEXT_VERSION = ContextVersion.$2;

export const backwardCompatabilityContextUtils = {
    makeActionContextBackwardCompatible({ context, contextVersion }: Params): unknown {
        switch (contextVersion) {
$3
        }
    },
}

type Params = { context: unknown; contextVersion: ContextVersion | undefined }
FIXTURE
}

# $1 = case lines of the connection resolver's switch, before its default
write_connection_resolver() {
  cat > "$root/packages/server/engine/src/lib/qadam-context/connection-resolver.ts" <<FIXTURE
import { ContextVersion } from '@aiqadam/qadams-framework'

const getConnectionValue = (connection: { value: unknown }, contextVersion: ContextVersion | undefined): unknown => {
    switch (contextVersion) {
$1
        default:
            return connection.value
    }
}
FIXTURE
}

# $1 = the "majors" array, as JSON
write_table() {
  printf '{\n  "majors": %s\n}\n' "$1" > "$root/packages/qadams/framework/src/lib/context/framework-support-table.json"
}

write_framework_version() {
  printf '{\n  "name": "@aiqadam/qadams-framework",\n  "version": "%s"\n}\n' "$1" > "$root/packages/qadams/framework/package.json"
}

# $1 = qadam dir name, $2 = framework dependency spec
write_qadam() {
  mkdir -p "$root/packages/qadams/core/$1"
  printf '{\n  "name": "@aiqadam/qadam-%s",\n  "version": "0.1.0",\n  "dependencies": {\n    "@aiqadam/qadams-framework": "%s"\n  }\n}\n' "$1" "$2" > "$root/packages/qadams/core/$1/package.json"
}

DISPATCH_TODAY='            case ContextVersion.V2:
                return context;
            case ContextVersion.V1:
                return { ...context, legacy: true };
            case undefined:
                return { ...context, legacy: true, serverUrl: true };'
RESOLVER_TODAY='        case undefined:
            return { legacy: connection.value }
        case ContextVersion.V1:
            return connection.value'
TABLE_TODAY='[ { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": null } ]'

# Three majors: 1.0.0 kept context V2, 2.0.0 introduced V3. 0.x's window runs to 2028-01-15.
TABLE_THREE='[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-15", "successorReleased": "2027-06-01" },
    { "major": 2, "contextVersions": ["3"], "released": "2027-06-01", "successorReleased": null }
  ]'
ENUM_THREE="V1 = '1', V2 = '2', V3 = '3',"
DISPATCH_THREE='            case ContextVersion.V3:
                return context;
            case ContextVersion.V2:
                return { ...context, v2: true };
            case ContextVersion.V1:
                return { ...context, legacy: true };
            case undefined:
                return { ...context, legacy: true, serverUrl: true };'
DISPATCH_THREE_WITHOUT_0X='            case ContextVersion.V3:
                return context;
            case ContextVersion.V2:
                return { ...context, v2: true };'

# The tree as it is today, committed as the base. Later edits to the working tree are the PR head.
new_repo() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "$root/packages/qadams/framework/src/lib/context" \
    "$root/packages/server/engine/src/lib/handler" \
    "$root/packages/server/engine/src/lib/qadam-context"
  write_framework_version "0.35.1"
  write_versioning "V1 = '1', V2 = '2'," "V2" "$DISPATCH_TODAY"
  write_connection_resolver "$RESOLVER_TODAY"
  write_table "$TABLE_TODAY"
  write_qadam "demo" "workspace:*"
  cat > "$root/packages/server/engine/src/lib/handler/qadam-executor.ts" <<'FIXTURE'
import { backwardCompatabilityContextUtils } from '@aiqadam/qadams-framework'

export const run = (context: unknown, version: undefined) => backwardCompatabilityContextUtils.makeActionContextBackwardCompatible({ context, contextVersion: version })
FIXTURE
  commit_base
}

commit_base() {
  git -C "$root" init -q 2>/dev/null || { echo "fixture setup: git init failed"; exit 1; }
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name test
  commit_all base
}

# Commits the working tree as the new PR base. The commit date is pinned because the table-history
# check reads it: a date the PR fills in may not be earlier than one day before the base commit.
commit_all() {
  git -C "$root" add -A
  GIT_AUTHOR_DATE=2026-10-01T00:00:00Z GIT_COMMITTER_DATE=2026-10-01T00:00:00Z \
    git -C "$root" -c commit.gpgsign=false commit -qm "$1" \
    || { echo "fixture setup: git commit failed ($1)"; exit 1; }
  base_sha="$(git -C "$root" rev-parse HEAD)"
  [ -n "$base_sha" ] || { echo "fixture setup: no base SHA after committing $1"; exit 1; }
}

# A base already on three majors, with every shim still in place.
new_repo_three_majors() {
  new_repo
  write_framework_version "2.0.0"
  write_versioning "$ENUM_THREE" "V3" "$DISPATCH_THREE"
  write_table "$TABLE_THREE"
  commit_all three-majors
}

# $1 = --now date; remaining args go to the checker
run_check() {
  local now="$1"
  shift
  out="$(node "$checker" --root "$root" --now "$now" "$@" 2>&1)"
  status=$?
}

run_check_base() {
  run_check "$1" --base "$base_sha"
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

echo "== today's tree passes =="
new_repo
run_check_base 2026-10-08
expect_status 0 "the 0.x row, V1 and pre-getContextInfo shims in place"
expect_contains "0.x (contexts none, 1, 2): supported — the current major" "0.x is the current major"
expect_contains "official qadams: 1" "the qadam was read"
expect_contains "2 shim site(s) at base, 2 now" "both shim sites were found, at base and at head"

echo "== [#801] removing a shim while its major is supported fails =="
new_repo
write_versioning "V1 = '1', V2 = '2'," "V2" '            case ContextVersion.V2:
                return context;
            case undefined:
                return { ...context, legacy: true, serverUrl: true };'
run_check_base 2026-10-08
expect_status 1 "the V1 shim removed from the dispatcher"
expect_contains 'context shim "1" is missing from `makeActionContextBackwardCompatible`' "the tree check names the shim"
expect_contains 'a context shim for "1" was removed: 2 shim site(s) handled it at' "the base comparison names it too"
expect_contains "0.x still needs it — the current major" "the reason is the table's"
# The tree check alone catches it, so a push to main or a tag build (no PR base) catches it too.
run_check 2026-10-08
expect_status 1 "the dispatcher check needs no base"
# Far in the future 0.x is still the current major, so the passage of time alone never allows it.
run_check_base 2040-01-01
expect_status 1 "time alone does not retire the current major"

echo "== removing a shim outside the dispatcher is caught against the PR base =="
new_repo
write_connection_resolver '        case ContextVersion.V1:
            return connection.value'
run_check_base 2026-10-08
expect_status 1 "the connection resolver's pre-getContextInfo shim removed"
expect_contains 'a context shim for "none" was removed: 2 shim site(s) handled it' "named by context"
expect_contains "no longer in packages/server/engine/src/lib/qadam-context/connection-resolver.ts getConnectionValue" "named by site"
# Documented limit: without a base the tree alone cannot show a branch that is gone.
run_check 2026-10-08
expect_status 0 "without a base only the dispatcher is checked"
expect_contains "removal check against base: skipped" "and the output says the comparison was skipped"

echo "== moving a shim to another function is not a removal =="
new_repo
cat > "$root/packages/server/engine/src/lib/qadam-context/connection-resolver.ts" <<'FIXTURE'
import { ContextVersion } from '@aiqadam/qadams-framework'

const getConnectionValue = (connection: { value: unknown }, contextVersion: ContextVersion | undefined): unknown => legacyValue(connection, contextVersion)

function legacyValue(connection: { value: unknown }, contextVersion: ContextVersion | undefined): unknown {
    if (contextVersion === undefined) {
        return { legacy: connection.value }
    }
    if (contextVersion === ContextVersion.V1) {
        return connection.value
    }
    return connection.value
}
FIXTURE
run_check_base 2026-10-08
expect_status 0 "same number of branches per context, different place and shape"

echo "== [#801] removing a shim 12 months after its successor, two majors on, passes =="
new_repo_three_majors
write_versioning "$ENUM_THREE" "V3" "$DISPATCH_THREE_WITHOUT_0X"
write_connection_resolver '        case ContextVersion.V2:
            return connection.value'
run_check_base 2028-01-15
expect_status 0 "0.x retired on the first day it may be"
expect_contains "0.x (contexts none, 1, 2): retirable" "0.x is reported retirable"
expect_contains "1.x (contexts 2): supported — the previous major" "1.x is still supported"

echo "== ... and fails one day earlier =="
run_check_base 2028-01-14
expect_status 1 "one day inside the 12 months"
expect_contains 'context shim "1" is missing' "the V1 shim is still owed"
expect_contains "supported until 2028-01-15" "the date it may go is named"

echo "== the gate is monotonic in time: a later date only ever allows more =="
for day in 2027-01-14 2027-06-01 2028-01-14; do
  run_check_base "$day"
  expect_status 1 "the removal is refused on $day"
done
for day in 2028-01-15 2029-01-01 2040-01-01; do
  run_check_base "$day"
  expect_status 0 "the removal is allowed on $day"
done
# A tree that keeps every shim passes on every date — time never makes existing code fail.
new_repo_three_majors
for day in 2026-10-08 2027-01-14 2028-01-15 2040-01-01; do
  run_check_base "$day"
  expect_status 0 "an untouched three-major tree passes on $day"
done

echo "== 12 months are not enough while only one later major exists =="
new_repo
write_framework_version "1.0.0"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-15", "successorReleased": null }
  ]'
commit_all one-later-major
write_versioning "V1 = '1', V2 = '2'," "V2" '            case ContextVersion.V2:
                return context;'
run_check_base 2040-01-01
expect_status 1 "0.x is the previous major, so it stays"
expect_contains "the previous major; retirable no earlier than 2028-01-15 and only once 2.0.0 is released" "both halves of the rule are named"

echo "== [#801] a framework major released without a row fails =="
new_repo
write_framework_version "1.0.0"
run_check_base 2026-10-08
expect_status 1 "framework 1.0.0, table still 0.x only"
expect_contains "framework major 1 (@aiqadam/qadams-framework@1.0.0 in packages/qadams/framework/package.json) is released without a row" "the condition is named"
expect_contains 'set 0.x.successorReleased to the same date' "the fix is named"
# Adding the row, and the 0.x successor date with it, makes it pass.
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-10-08" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-10-08", "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 0 "the release PR with its row"
# A prerelease of the next major needs its row too.
write_framework_version "2.0.0-rc.1"
run_check_base 2026-10-08
expect_status 1 "2.0.0-rc.1 without a row"
expect_contains 'framework major 2 (the prerelease @aiqadam/qadams-framework@2.0.0-rc.1' "the prerelease's major is named"
expect_contains '"released": null' "and the row it needs carries no date"

echo "== a prerelease of a new major is not a release =="
new_repo
write_framework_version "1.0.0-rc.1"
run_check_base 2026-10-08
expect_status 1 "1.0.0-rc.1 without a row"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": null },
    { "major": 1, "contextVersions": ["2"], "released": null, "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 0 "1.0.0-rc.1 with an undated row"
expect_contains "(a prerelease of 1.0.0)" "the prerelease is reported"
expect_contains "0.x (contexts none, 1, 2): supported — the current major" "0.x is still the current released major"
expect_contains "1.x (contexts 2): supported — not released yet" "1.x is on its way"
# A dated row for a prerelease would start 0.x's 12-month window before 1.0.0 exists.
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-10-08" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-10-08", "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 1 "a prerelease row with a release date"
expect_contains "a prerelease does not start 0.x's 12-month window" "named"
# 1.0.0 itself: the dates are filled in, from null, in the release PR.
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": null },
    { "major": 1, "contextVersions": ["2"], "released": null, "successorReleased": null }
  ]'
commit_all rc
write_framework_version "1.0.0"
run_check_base 2026-10-08
expect_status 1 "1.0.0 with its row still undated"
expect_contains "1.x.released is null" "named"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-10-08" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-10-08", "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 0 "1.0.0 released, dates filled in from null"
# A prerelease inside a released major is that major, not a new one.
commit_all ga
write_framework_version "1.1.0-next.0"
run_check_base 2026-10-08
expect_status 0 "1.1.0-next.0 inside the released 1.x"
expect_not_contains "a prerelease of" "not reported as a new major on its way"

echo "== a prerelease of the next major does not retire the one before the current =="
new_repo
write_framework_version "1.0.0"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-10-01" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-10-01", "successorReleased": null }
  ]'
commit_all one-zero
write_framework_version "2.0.0-next.3"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-10-01" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-10-01", "successorReleased": null },
    { "major": 2, "contextVersions": ["2"], "released": null, "successorReleased": null }
  ]'
write_versioning "V1 = '1', V2 = '2'," "V2" '            case ContextVersion.V2:
                return context;'
write_connection_resolver ''
run_check_base 2030-01-01
expect_status 1 "0.x's shims removed under 2.0.0-next.3, years after 1.0.0"
expect_contains "0.x still needs it — the previous major" "0.x is the previous released major until 2.0.0 itself"

echo "== a row for a major that is not released fails =="
new_repo
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-15", "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 1 "a row ahead of the release would start 0.x's clock early"
expect_contains "has a row for framework major 1, but packages/qadams/framework/package.json is 0.35.1" "named"

echo "== [#801] an official qadam built against a major the engine no longer supports fails =="
new_repo_three_majors
write_versioning "$ENUM_THREE" "V3" "$DISPATCH_THREE_WITHOUT_0X"
write_connection_resolver '        case ContextVersion.V2:
            return connection.value'
write_qadam "stale" "0.35.1"
run_check_base 2028-01-15
expect_status 1 "0.x retired correctly, but an official qadam still pins it"
expect_contains "1 official qadam(s) are built against framework major 0.x, which the engine no longer supports (no shim for none, 1" "named"
expect_contains "@aiqadam/qadam-stale (@aiqadam/qadams-framework@0.35.1" "the qadam is named"
expect_not_contains "qadam-demo" "the workspace:* qadam is fine"
# Not a question of time: it fails on every later date as well.
run_check_base 2040-01-01
expect_status 1 "still refused much later"
# A major the table has never heard of is not supported either.
write_qadam "stale" "^9.0.0"
run_check_base 2028-01-15
expect_status 1 "framework major 9 has no row"
expect_contains "built against framework major 9, which has no row" "named"
# Rebuilding it against the tree's framework clears it.
write_qadam "stale" "workspace:*"
run_check_base 2028-01-15
expect_status 0 "rebuilt against workspace:*"

echo "== a new context version without a new major fails =="
new_repo
write_versioning "V1 = '1', V2 = '2', V3 = '3'," "V3" "$DISPATCH_THREE"
run_check_base 2026-10-08
expect_status 1 "LATEST_CONTEXT_VERSION moved to V3 under framework 0.x"
expect_contains "LATEST_CONTEXT_VERSION is 3" "named"

echo "== the table must agree with itself =="
new_repo_three_majors
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-15", "successorReleased": "2027-06-01" },
    { "major": 2, "contextVersions": ["3"], "released": "2027-06-01", "successorReleased": null }
  ]'
run_check_base 2028-01-15
expect_status 1 "a successor date that is not the next row's release date"
expect_contains "0.x.successorReleased (2026-01-15) must equal 1.x.released (2027-01-15)" "named"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-15" },
    { "major": 2, "contextVersions": ["3"], "released": "2027-01-15", "successorReleased": null }
  ]'
run_check_base 2028-01-15
expect_status 1 "a gap in the majors"
expect_contains "rows must run 0, 1, 2" "named"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "7"], "released": null, "successorReleased": null }
  ]'
write_framework_version "0.35.1"
run_check_base 2026-10-08
expect_status 1 "an unknown context version"
expect_contains 'which is neither a ContextVersion value' "named"
write_table '[ { "major": 0, "contextVersions": ["none", "1", "2"], "released": "last week", "successorReleased": null } ]'
run_check_base 2026-10-08
expect_status 1 "a date that is not a date"
expect_contains '.released must be a YYYY-MM-DD date' "named"

echo "== [review] narrowing a row and deleting its shim in the same PR fails =="
new_repo
write_table '[ { "major": 0, "contextVersions": ["none", "2"], "released": null, "successorReleased": null } ]'
write_versioning "V1 = '1', V2 = '2'," "V2" '            case ContextVersion.V2:
                return context;
            case undefined:
                return { ...context, legacy: true, serverUrl: true };'
write_connection_resolver '        case undefined:
            return { legacy: connection.value }'
run_check_base 2026-10-08
expect_status 1 "0.x row narrowed to drop V1, V1 shims deleted"
expect_contains '0.x.contextVersions changed from ["none","1","2"] to ["none","2"]' "the table edit is named"
# Narrowing to nothing but the latest and deleting every shim is the same edit.
write_table '[ { "major": 0, "contextVersions": ["2"], "released": null, "successorReleased": null } ]'
write_versioning "V1 = '1', V2 = '2'," "V2" '            case ContextVersion.V2:
                return context;'
write_connection_resolver ''
run_check_base 2026-10-08
expect_status 1 "0.x row narrowed to V2 only, all shims deleted"
expect_contains '0.x.contextVersions changed' "named"

echo "== [review] backdating a recorded release to retire a major early fails =="
new_repo_three_majors
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2026-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2026-01-15", "successorReleased": "2027-06-01" },
    { "major": 2, "contextVersions": ["3"], "released": "2027-06-01", "successorReleased": null }
  ]'
write_versioning "$ENUM_THREE" "V3" "$DISPATCH_THREE_WITHOUT_0X"
write_connection_resolver '        case ContextVersion.V2:
            return connection.value'
run_check_base 2027-02-01
expect_status 1 "1.0.0 moved a year back so 0.x's window has passed"
expect_contains "1.x.released changed from 2027-01-15 to 2026-01-15" "named"
expect_contains "0.x.successorReleased changed from 2027-01-15 to 2026-01-15" "both sides of the date are named"

echo "== [review] appending backdated rows to retire a major early fails =="
new_repo
write_framework_version "2.0.0"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2020-01-01" },
    { "major": 1, "contextVersions": ["2"], "released": "2020-01-01", "successorReleased": "2020-06-01" },
    { "major": 2, "contextVersions": ["3"], "released": "2020-06-01", "successorReleased": null }
  ]'
write_versioning "$ENUM_THREE" "V3" "$DISPATCH_THREE_WITHOUT_0X"
write_connection_resolver '        case ContextVersion.V2:
            return connection.value'
run_check_base 2026-10-08
expect_status 1 "two majors recorded as released in 2020 by a PR based on 2026-10-01"
expect_contains "1.x.released is set to 2020-01-01 in this change, before its base (2026-10-01)" "named"

echo "== a release date in the future fails until that day =="
new_repo
write_framework_version "1.0.0"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-01" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-01", "successorReleased": null }
  ]'
run_check_base 2026-10-08
expect_status 1 "1.0.0 recorded as released next year"
expect_contains "which is after today (2026-10-08)" "named"
run_check_base 2027-01-01
expect_status 0 "and accepted on the day: time only turns a failure into a pass"

echo "== a deleted row fails =="
new_repo_three_majors
write_framework_version "1.0.0"
write_table '[
    { "major": 0, "contextVersions": ["none", "1", "2"], "released": null, "successorReleased": "2027-01-15" },
    { "major": 1, "contextVersions": ["2"], "released": "2027-01-15", "successorReleased": null }
  ]'
write_versioning "V1 = '1', V2 = '2'," "V2" "$DISPATCH_TODAY"
run_check_base 2028-01-15
expect_status 1 "the 2.x row dropped"
expect_contains "the row for 2.x was deleted" "named"

echo "== the engine must still call the dispatcher =="
new_repo
printf 'export const run = () => undefined\n' > "$root/packages/server/engine/src/lib/handler/qadam-executor.ts"
run_check_base 2026-10-08
expect_status 1 "the dispatcher is intact but nothing calls it"
# Naming it is not calling it.
printf "// makeActionContextBackwardCompatible used to be called here\nimport { makeActionContextBackwardCompatible } from 'x'\nexport const run = () => makeActionContextBackwardCompatible\n" > "$root/packages/server/engine/src/lib/handler/qadam-executor.ts"
run_check_base 2026-10-08
expect_status 1 "a comment, an import and a reference, but no call"
expect_contains "nothing under packages/server/engine/src calls \`makeActionContextBackwardCompatible\`" "named"

echo "== the gate fails loudly rather than pass having checked nothing =="
new_repo
run_check 2026-10-08 --base 0000000000000000000000000000000000000000
expect_status 1 "an unreachable PR base"
expect_contains "cannot resolve the PR base" "named"
# A `git show` that fails at the base must not shrink the base to nothing and report "no shim
# removed". A stub `git` on PATH fails only that one read and passes everything else through.
new_repo
real_git="$(command -v git)"
mkdir -p "$root/.stub-bin"
cat > "$root/.stub-bin/git" <<STUB
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in *:packages/server/engine/src/lib/qadam-context/connection-resolver.ts) [ "\$1" = "-C" ] && [ "\$3" = "show" ] && exit 128 ;; esac
done
exec "$real_git" "\$@"
STUB
chmod +x "$root/.stub-bin/git"
out="$(PATH="$root/.stub-bin:$PATH" node "$checker" --root "$root" --now 2026-10-08 --base "$base_sha" 2>&1)"
status=$?
expect_status 1 "a base file git show cannot read"
expect_contains "\`git show\` failed at" "named"
new_repo
rm "$root/packages/qadams/framework/src/lib/context/framework-support-table.json"
run_check_base 2026-10-08
expect_status 1 "no table"
expect_contains "framework-support-table.json is missing" "named"
new_repo
rm -rf "$root/packages/qadams/core"
run_check_base 2026-10-08
expect_status 1 "no official qadams"
expect_contains "found no official qadam package.json" "named"
new_repo
rm "$root/packages/qadams/framework/src/lib/context/versioning.ts"
run_check_base 2026-10-08
expect_status 1 "no versioning.ts"
expect_contains "cannot read packages/qadams/framework/src/lib/context/versioning.ts" "named"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "framework support gate tests FAILED."
  exit 1
fi
echo "framework support gate tests passed."
