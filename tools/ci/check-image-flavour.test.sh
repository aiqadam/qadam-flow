#!/usr/bin/env bash
#
# Tests for tools/ci/check-image-flavour.sh (#807, ADR-0003): the pure-shell wrapper ci.yml and
# release.yml both depend on to smoke a built/published image. Stubs `docker` so the wrapper's own
# logic — argument validation, the pull-vs-already-local branch, the flavour-label check, and exit
# code propagation from the in-container check — is exercised without building or running a real
# image. The in-container Node check itself has no stand-in here; that behaviour belongs to the
# script under test, not to this stub.
#
#   tools/ci/check-image-flavour.test.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sut="${here}/check-image-flavour.sh"

pass=0
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() {
  pass=$((pass + 1))
  printf 'ok    %s\n' "$1"
}

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s: %s\n' "$1" "$2"
}

expect_exit() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then ok "$name (exit $actual)"; else fail_case "$name" "expected exit $expected, got $actual"; fi
}

dockerbin="${tmp}/dockerbin"
mkdir -p "$dockerbin"
cat > "${dockerbin}/docker" <<'DOCKER'
#!/bin/sh
: "${DOCKER_LOG:?}"
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  image)
    [ "${DOCKER_IMAGE_PRESENT:-no}" = yes ]
    exit $?
    ;;
  pull)
    exit "${DOCKER_PULL_EXIT:-0}"
    ;;
  inspect)
    printf '%s' "${DOCKER_LABEL-slim}"
    exit "${DOCKER_INSPECT_EXIT:-0}"
    ;;
  run)
    exit "${DOCKER_RUN_EXIT:-0}"
    ;;
  *)
    exit 1
    ;;
esac
DOCKER
chmod +x "${dockerbin}/docker"

# Usage: no arguments at all.
"$sut" >"${tmp}/.out" 2>"${tmp}/.err"
expect_exit "no arguments" 2 $?

# Usage: an unrecognised flavour.
"$sut" ghcr.io/aiqadam/qadam-flow:slim bogus >/dev/null 2>&1
expect_exit "unrecognised flavour" 2 $?

# Usage: a valid flavour but no image.
"$sut" '' fat >/dev/null 2>&1
expect_exit "empty image" 2 $?

# A locally-present image is not pulled.
present_work="${tmp}/present"
mkdir -p "$present_work"
PATH="$dockerbin:$PATH" DOCKER_LOG="${present_work}/.log" DOCKER_IMAGE_PRESENT=yes DOCKER_LABEL=slim \
  "$sut" ghcr.io/aiqadam/qadam-flow:slim slim >/dev/null 2>"${present_work}/.err"
status=$?
expect_exit "locally-present image: wrapper succeeds" 0 "$status"
if grep -q '^pull ' "${present_work}/.log"; then
  fail_case "locally-present image is not pulled" "$(cat "${present_work}/.log")"
else
  ok "locally-present image is not pulled"
fi

# An image absent locally is pulled exactly once.
absent_work="${tmp}/absent"
mkdir -p "$absent_work"
PATH="$dockerbin:$PATH" DOCKER_LOG="${absent_work}/.log" DOCKER_IMAGE_PRESENT=no DOCKER_LABEL=fat \
  "$sut" ghcr.io/aiqadam/qadam-flow:fat fat >/dev/null 2>"${absent_work}/.err"
expect_exit "image absent locally: wrapper succeeds" 0 $?
if [ "$(grep -c '^pull ' "${absent_work}/.log")" = 1 ]; then
  ok "image absent locally is pulled exactly once"
else
  fail_case "image absent locally is pulled exactly once" "$(cat "${absent_work}/.log")"
fi

# A label that does not match the requested flavour aborts before the in-container check runs.
mismatch_work="${tmp}/mismatch"
mkdir -p "$mismatch_work"
PATH="$dockerbin:$PATH" DOCKER_LOG="${mismatch_work}/.log" DOCKER_IMAGE_PRESENT=yes DOCKER_LABEL=fat \
  "$sut" ghcr.io/aiqadam/qadam-flow:slim slim >/dev/null 2>"${mismatch_work}/.err"
expect_exit "mismatched flavour label aborts" 1 $?
if grep -qF 'expected label org.aiqadam.qadam-flavour=slim' "${mismatch_work}/.err"; then
  ok "mismatched flavour label reports what it expected"
else
  fail_case "mismatched flavour label reports what it expected" "$(cat "${mismatch_work}/.err")"
fi
if grep -q '^run ' "${mismatch_work}/.log"; then
  fail_case "mismatched flavour label skips the in-container check" "$(cat "${mismatch_work}/.log")"
else
  ok "mismatched flavour label skips the in-container check"
fi

# A matching label runs the in-container check and propagates its exit code.
run_fail_work="${tmp}/run-fail"
mkdir -p "$run_fail_work"
PATH="$dockerbin:$PATH" DOCKER_LOG="${run_fail_work}/.log" DOCKER_IMAGE_PRESENT=yes DOCKER_LABEL=slim DOCKER_RUN_EXIT=1 \
  "$sut" ghcr.io/aiqadam/qadam-flow:slim slim >/dev/null 2>"${run_fail_work}/.err"
expect_exit "in-container check failure propagates" 1 $?
if grep -q '^run ' "${run_fail_work}/.log"; then
  ok "matching label reaches the in-container check"
else
  fail_case "matching label reaches the in-container check" "$(cat "${run_fail_work}/.log")"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
