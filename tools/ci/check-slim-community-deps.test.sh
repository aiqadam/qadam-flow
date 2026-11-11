#!/usr/bin/env bash
#
# Tests for tools/ci/check-slim-community-deps.sh (#807): builds a fixture repo tree (a Dockerfile
# fragment, a check-image-flavour.sh fragment, server/worker source, and community qadam
# directories) so the three-way consistency check can be exercised without touching the real
# Dockerfile or server source.
#
#   tools/ci/check-slim-community-deps.test.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sut="${here}/check-slim-community-deps.sh"

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

# Builds a fixture repo under "$1" with:
#   kept: space-separated community qadam names the Dockerfile fragment and check-image-flavour.sh
#         fragment both keep
#   flavour_kept: space-separated names check-image-flavour.sh's own fragment keeps (defaults to
#         $kept; pass a different list to simulate the two drifting apart)
#   imported: space-separated community qadam names the fixture server source actually imports
build_fixture() {
  local root="$1" kept="$2" flavour_kept="${3:-$2}" imported="$4"
  mkdir -p "${root}/packages/server/api/src/app/some-module" "${root}/packages/server/worker/src"
  mkdir -p "${root}/packages/qadams/community"

  local dockerfile_names="" name
  for name in $kept; do
    dockerfile_names="${dockerfile_names} ! -name ${name}"
    mkdir -p "${root}/packages/qadams/community/${name}"
  done
  printf 'RUN find packages/qadams/community -mindepth 1 -maxdepth 1 -type d%s -exec rm -rf {} +\n' "$dockerfile_names" > "${root}/Dockerfile"

  local flavour_js=""
  for name in $flavour_kept; do
    flavour_js="${flavour_js}'${name}', "
  done
  printf "const ALWAYS_BUNDLED_COMMUNITY = [%s]\n" "${flavour_js%, }" > "${root}/check-image-flavour.sh"

  : > "${root}/packages/server/api/src/app/some-module/imports.ts"
  for name in $imported; do
    mkdir -p "${root}/packages/qadams/community/${name}"
    printf "import { x } from '@aiqadam/qadam-%s'\n" "$name" >> "${root}/packages/server/api/src/app/some-module/imports.ts"
  done
}

run_sut() {
  local root="$1"
  CHECK_SLIM_COMMUNITY_DEPS_REPO="$root" \
  CHECK_SLIM_COMMUNITY_DEPS_DOCKERFILE="${root}/Dockerfile" \
  CHECK_SLIM_COMMUNITY_DEPS_FLAVOUR_CHECK="${root}/check-image-flavour.sh" \
    "$sut"
}

# The common case: the Dockerfile keeps exactly what the server imports, and
# check-image-flavour.sh agrees.
in_sync="${tmp}/in-sync"
build_fixture "$in_sync" "facebook-leads intercom slack telegram-bot" "" "facebook-leads intercom slack telegram-bot"
out="$(run_sut "$in_sync" 2>&1)"
expect_exit "in-sync fixture passes" 0 $?
if ! printf '%s' "$out" | grep -qF 'ok ('; then
  fail_case "in-sync fixture reports ok" "$out"
fi

# A server import with nothing pruning it: the regression this check exists to catch.
missing_from_dockerfile="${tmp}/missing-from-dockerfile"
build_fixture "$missing_from_dockerfile" "facebook-leads intercom slack" "" "facebook-leads intercom slack telegram-bot"
out="$(run_sut "$missing_from_dockerfile" 2>&1)"
expect_exit "an unlisted import fails" 1 $?
if printf '%s' "$out" | grep -qF 'telegram-bot'; then
  ok "an unlisted import names the missing qadam"
else
  fail_case "an unlisted import names the missing qadam" "$out"
fi

# The Dockerfile and check-image-flavour.sh disagree with each other, even though both happen to
# cover every actual import.
lists_disagree="${tmp}/lists-disagree"
build_fixture "$lists_disagree" "facebook-leads intercom slack telegram-bot" "facebook-leads intercom slack" "facebook-leads intercom slack"
out="$(run_sut "$lists_disagree" 2>&1)"
expect_exit "disagreeing lists fail" 1 $?
if printf '%s' "$out" | grep -qF 'disagree'; then
  ok "disagreeing lists report the disagreement"
else
  fail_case "disagreeing lists report the disagreement" "$out"
fi

# A kept qadam the server does not actually import is not itself a failure — slim is allowed to
# keep more than the minimum the server is proven to need.
extra_kept="${tmp}/extra-kept"
build_fixture "$extra_kept" "facebook-leads intercom slack telegram-bot" "" "facebook-leads"
out="$(run_sut "$extra_kept" 2>&1)"
expect_exit "keeping an unimported qadam is not a failure" 0 $?

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
