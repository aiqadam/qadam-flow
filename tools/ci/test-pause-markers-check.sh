#!/usr/bin/env bash
#
# Fixture tests for the pause-marker scan (#426).
#
# The checker is a static scan over qadam source — see the header comment in
# check-pause-markers.mjs. These fixtures pin the cases it must catch (a waiting action without
# `pauses`, a waiting helper whose consumer lacks it, a stale marker on an action that never
# waits, a helper nobody imports) and the cases it must stay silent on (a marked waiting action,
# a marked consumer of a waiting helper, an action that only creates a waitpoint).
#
# Run from the "Lint + unit test suite" job (it only needs node + the workspace deps).
#
#   tools/ci/test-pause-markers-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-pause-markers.mjs"

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

new_root() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "$root/packages/qadams/community/demo-qadam/src/lib/actions"
  mkdir -p "$root/packages/qadams/community/demo-qadam/src/lib/common"
  mkdir -p "$root/packages/qadams/core/demo-core-qadam/src/lib/actions"
}

# $1 = file path, $2 = extra createAction fields (e.g. "pauses: true,"), $3 = run body,
# $4 = extra import lines
write_action() {
  cat > "$1" <<FIXTURE
import { createAction } from '@aiqadam/qadams-framework';
$4

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  $2
  props: {},
  async run(context) {
$3
  },
});
FIXTURE
}

write_helper() {
  cat > "$1" <<'FIXTURE'
export async function waitForIt(context) {
  const waitpoint = await context.run.createWaitpoint({ type: 'WEBHOOK' });
  context.run.waitForWaitpoint(waitpoint.id);
}
FIXTURE
}

run_check() {
  out="$(node "$checker" --root "$root" 2>&1)"
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

WAITS='    const waitpoint = await context.run.createWaitpoint({ type: "WEBHOOK" });
    context.run.waitForWaitpoint(waitpoint.id);
    return {};'
CREATES_ONLY='    const waitpoint = await context.run.createWaitpoint({ type: "WEBHOOK" });
    return { url: waitpoint.buildResumeUrl({ queryParams: {} }) };'
PLAIN='    return context.propsValue;'

echo "== a marked waiting action passes =="
new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/wait.ts" "pauses: true," "$WAITS" ""
write_action "$root/packages/qadams/core/demo-core-qadam/src/lib/actions/plain.ts" "" "$PLAIN" ""
run_check
expect_status 0 "marked waiting action + plain action"
expect_contains "every pausing action declares" "marked waiting action"

echo "== a conditional marker passes too =="
new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/wait.ts" "pauses: 'conditional'," "$WAITS" ""
run_check
expect_status 0 "conditional marker"

echo "== a waiting action without the marker is caught =="
new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/wait.ts" "" "$WAITS" ""
run_check
expect_status 1 "unmarked waiting action"
expect_contains 'action "demo_action" calls waitForWaitpoint but declares no `pauses`' "unmarked waiting action"

echo "== creating a waitpoint without waiting on it needs no marker =="
new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/links.ts" "" "$CREATES_ONLY" ""
run_check
expect_status 0 "createWaitpoint only"

echo "== a stale marker on an action that never waits is caught =="
new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/plain.ts" "pauses: true," "$PLAIN" ""
run_check
expect_status 1 "stale marker"
expect_contains "declares \`pauses\` but nothing in its file" "stale marker"

echo "== a waiting helper's consumer must carry the marker =="
new_root
write_helper "$root/packages/qadams/community/demo-qadam/src/lib/common/wait-helper.ts"
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/via-helper.ts" "" "    return waitForIt(context);" "import { waitForIt } from '../common/wait-helper';"
run_check
expect_status 1 "unmarked helper consumer"
expect_contains "imports a helper that calls waitForWaitpoint but declares no" "unmarked helper consumer"

echo "== a marked consumer of a waiting helper passes =="
new_root
write_helper "$root/packages/qadams/community/demo-qadam/src/lib/common/wait-helper.ts"
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/via-helper.ts" "pauses: true," "    return waitForIt(context);" "import { waitForIt } from '../common/wait-helper';"
run_check
expect_status 0 "marked helper consumer"

echo "== a waiting helper nobody imports is reported, not ignored =="
new_root
write_helper "$root/packages/qadams/community/demo-qadam/src/lib/common/wait-helper.ts"
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/plain.ts" "" "$PLAIN" ""
run_check
expect_status 1 "orphan helper"
expect_contains "no action file imports it" "orphan helper"

echo "== an empty tree fails loudly =="
new_root
rm -rf "$root/packages"
run_check
expect_status 1 "empty tree"
expect_contains "scanned 0 files" "empty tree"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
