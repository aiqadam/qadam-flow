#!/usr/bin/env bash
#
# Wait for an HTTP endpoint to return 200, or fail the caller.
#
#   tools/ci/wait-for-api.sh <url> <timeout-seconds> [poll-seconds]
#
# ci.yml's `e2e` job calls this twice — once per boot phase — which is why it is
# a script rather than an inline loop: a readiness gate duplicated in two places
# is a readiness gate that drifts, and both copies have to fail the same way.
#
# It must fail CLOSED, and that is the whole point. A timeout that reported
# success would hand the Playwright suite a stack that never came up, and every
# spec would then time out on a URL that was never served — reported as a UI
# regression rather than as a boot failure. Same reason the argument checks
# below exit non-zero: an unusable timeout is unknown, not "wait forever" and
# not "ready".
#
# Not run.sh's `wait_for_app`, which is the closest existing thing: its deadline
# is fixed at 3 min for a warm local docker, and its failure message tells the
# reader to cd into the installer's directory, which does not exist in CI.

set -uo pipefail

main() {
  local url="${1:-}"
  local timeout="${2:-}"
  local poll="${3:-5}"

  if [ -z "$url" ] || [ -z "$timeout" ]; then
    echo "::error::usage: $0 <url> <timeout-seconds> [poll-seconds]" >&2
    return 2
  fi

  case "$timeout" in
    ''|*[!0-9]*) echo "::error::timeout-seconds must be a positive integer (got '${timeout}')" >&2; return 2 ;;
  esac
  case "$poll" in
    ''|*[!0-9]*) echo "::error::poll-seconds must be a positive integer (got '${poll}')" >&2; return 2 ;;
  esac
  if [ "$timeout" -lt 1 ] || [ "$poll" -lt 1 ]; then
    echo "::error::timeout-seconds and poll-seconds must both be at least 1" >&2
    return 2
  fi

  local deadline=$(( $(date +%s) + timeout ))
  echo "Waiting up to ${timeout}s for ${url}"
  until curl -fsS -m 5 -o /dev/null "$url"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::${url} did not return 200 within ${timeout}s; the stack never became ready."
      return 1
    fi
    sleep "$poll"
  done
  echo "${url} answered 200. ✅"
}

# Sourceable so wait-for-api.test.sh can drive `main` without a subshell per case.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
