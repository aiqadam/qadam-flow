#!/usr/bin/env bash
#
# Tests for tools/ci/check-site-installer.sh (#30).
#
#   tools/ci/check-site-installer.test.sh
#
# The check itself talks to flow.aiqadam.org, so what it does on a *healthy* site is the
# one case that proves nothing: a gate only ever exercised against the state it should
# accept is not a gate. Every case below is a state it must REJECT, served from a local
# file:// tree so the suite needs no network and cannot flake.
#
# The rejections mirror the three ways this has actually gone wrong or could:
#   1. the file is not published at all — doctor.sh, 404 since #221 merged
#   2. the URL answers, but with an HTML error page a proxy or Pages 404 would serve
#   3. the file is a shell script, but a copy of the installer instead of a loader for it
#      — the drift the loader exists to remove, quietly reintroduced by a manual edit
#
# Runs in the unconditional `Lint + Unit Tests` job, like the other tools/ci suites.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="${here}/check-site-installer.sh"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# Each case gets its own directory served over file://, which curl handles natively — no
# listener, no port, nothing to leak between cases.
site="$(mktemp -d)"
trap 'rm -rf "${site}"' EXIT

expect_reject() {
  local label=$1 name=$2
  local out
  out="$(SITE_URL="file://${site}" sh "${check}" "${name}" 2>&1)"
  local rc=$?
  if [ "${rc}" -eq 0 ]; then
    bad "${label}: exited 0 — the check accepted a state it must reject"
    printf '      output: %s\n' "${out}"
    return
  fi
  if ! printf '%s' "${out}" | grep -q '^FAIL'; then
    bad "${label}: exited ${rc} but printed no FAIL line, so the reason would not reach a reader"
    return
  fi
  ok
}

expect_accept() {
  local label=$1 name=$2
  local out
  out="$(SITE_URL="file://${site}" sh "${check}" "${name}" 2>&1)"
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    bad "${label}: exited ${rc} — the check rejected a healthy state"
    printf '      output: %s\n' "${out}"
    return
  fi
  ok
}

echo "== a file that is not published at all is rejected (the doctor.sh case) =="
expect_reject "missing file" "doctor.sh"

echo "== an HTML error page served with a 200 is rejected, not piped onward =="
printf '<!doctype html>\n<html><body>404</body></html>\n' > "${site}/run.sh"
expect_reject "html body" "run.sh"

echo "== a shell script with no loader marker is rejected =="
{
  printf '#!/bin/sh\n'
  printf '# Qadam Flow - installer\n'
  printf 'echo installing\n'
} > "${site}/run.sh"
expect_reject "script without marker" "run.sh"

echo "== a marker in a file that is not a shell script does not rescue it =="
{
  printf '<!doctype html>\n'
  printf '<!-- # qadam-flow-loader: 1 -->\n'
} > "${site}/run.sh"
expect_reject "marker inside html" "run.sh"

echo "== one bad entry fails the run even when another is healthy =="
{
  printf '#!/bin/sh\n'
  printf '# qadam-flow-loader: 1\n'
} > "${site}/run.sh"
printf 'not a script\n' > "${site}/doctor.sh"
expect_reject "one of two broken" "run.sh doctor.sh"

echo "== the real loader files in the repo tree are accepted =="
{
  printf '#!/bin/sh\n'
  printf '# qadam-flow-loader: 1\n'
  printf 'echo loading\n'
} > "${site}/doctor.sh"
expect_accept "both healthy" "run.sh"
expect_accept "both healthy (doctor)" "doctor.sh"

printf '\npassed: %s   failed: %s\n' "${pass}" "${fail}"
if [ "${fail}" -ne 0 ]; then
  exit 1
fi
echo "check-site-installer.sh tests passed."
