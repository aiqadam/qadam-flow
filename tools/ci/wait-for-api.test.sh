#!/usr/bin/env bash
#
# Tests for tools/ci/wait-for-api.sh.
#
#   tools/ci/wait-for-api.test.sh
#
# The readiness gate in ci.yml's `e2e` job. Only one direction of it can rot
# unnoticed, so that is the direction covered here: a gate that reports success
# when the stack never came up turns every spec's timeout into a false UI
# regression, and nothing downstream can tell the difference.
#
# The success path is deliberately NOT simulated. Standing up a throwaway HTTP
# listener would be the flakiest thing in an otherwise pure-shell suite, and
# that path is exercised for real by the `e2e` job on every run — a script that
# never returns 0 makes that job red immediately, which is not a silent failure.
# What could be silent is the opposite, and it is what these cases pin.
#
# Pure shell, so it runs with the other tools/ci suites before any install.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# shellcheck source=./wait-for-api.sh
. "${here}/wait-for-api.sh"

expect_status() {
  local want="$1" desc="$2"
  shift 2
  local got=0
  main "$@" >/dev/null 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    ok
  else
    bad "${desc}: expected exit ${want}, got ${got}"
  fi
}

echo "== an unusable invocation fails rather than waiting or passing =="

expect_status 2 'no arguments at all'
expect_status 2 'url without a timeout' 'http://127.0.0.1:1/'
expect_status 2 'non-numeric timeout' 'http://127.0.0.1:1/' abc
expect_status 2 'zero timeout' 'http://127.0.0.1:1/' 0
expect_status 2 'non-numeric poll' 'http://127.0.0.1:1/' 5 abc
expect_status 2 'empty url' '' 5

echo "== an endpoint that never answers fails, bounded =="

# Port 1 on loopback: nothing listens, and connect is refused immediately rather
# than hanging, so the case costs about as long as the deadline it is given.
started="$(date +%s)"
status=0
main 'http://127.0.0.1:1/api/v1/flags' 2 1 >/dev/null 2>&1 || status=$?
elapsed=$(( $(date +%s) - started ))

if [ "$status" -eq 1 ]; then
  ok
else
  bad "an unreachable endpoint must exit 1, got ${status}"
fi

# The bound is half the assertion: a gate that fails only after the job's own
# timeout-minutes kills it reports "cancelled", not a diagnosable failure.
if [ "$elapsed" -lt 30 ]; then
  ok
else
  bad "the 2s deadline took ${elapsed}s to give up; the timeout is not bounded"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
