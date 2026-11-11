#!/bin/sh
# Keeps three independent copies of one list in sync (#807, ADR-0003): the
# community qadams `:slim`'s prune step in the Dockerfile keeps, the ones
# check-image-flavour.sh expects a slim image to carry, and the ones the server itself actually
# imports (app-event-routing.module.ts's static slack/facebook-leads/intercom imports,
# event-puller-registry.ts's dynamic telegram-bot import).
#
# This exists because the three already drifted once in this same PR: an earlier version of the
# Dockerfile's prune step deleted every community qadam unconditionally, and slim failed to boot
# with `Cannot find module '@aiqadam/qadam-facebook-leads'` — found only by actually building and
# running the image, which nothing in CI did at the time. A grep-based consistency check here
# catches a future drift (a new static/dynamic import of a fifth community qadam, or an edit to
# one list that is not mirrored in the other two) at review time instead of at boot.
#
#   tools/ci/check-slim-community-deps.sh
#
# Not a build-time or image-aware check: it reads the Dockerfile and check-image-flavour.sh as
# text and the server/worker source as text. It cannot see a qadam name computed at runtime (a
# template string, a constant built from a loop); only a literal `@aiqadam/qadam-<name>` package
# specifier in an import/require.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Overridable so the test suite can point this at a fixture tree instead of the real repo.
repo=${CHECK_SLIM_COMMUNITY_DEPS_REPO:-$(CDPATH= cd -- "${here}/../.." && pwd)}
dockerfile=${CHECK_SLIM_COMMUNITY_DEPS_DOCKERFILE:-${repo}/Dockerfile}
flavour_check=${CHECK_SLIM_COMMUNITY_DEPS_FLAVOUR_CHECK:-${here}/check-image-flavour.sh}

fail() {
  echo "check-slim-community-deps: $1" >&2
  exit 1
}

# The Dockerfile's slim-prune step: `find packages/qadams/community ... ! -name a ! -name b ...`.
dockerfile_names=$(grep -oE '! -name [A-Za-z0-9_-]+' "$dockerfile" | awk '{print $NF}' | sort -u)
[ -n "$dockerfile_names" ] || fail "found no '! -name' kept community qadam(s) in $dockerfile"

# check-image-flavour.sh's own ALWAYS_BUNDLED_COMMUNITY array.
flavour_check_names=$(grep -oE "const ALWAYS_BUNDLED_COMMUNITY = \[.*\]" "$flavour_check" \
  | grep -oE "'[A-Za-z0-9_-]+'" | tr -d "'" | sort -u)
[ -n "$flavour_check_names" ] || fail "found no ALWAYS_BUNDLED_COMMUNITY entries in $flavour_check"

# Actual static/dynamic imports of a community qadam from the server or worker source.
imported_names=$(grep -rhoE "from '@aiqadam/qadam-[a-z0-9-]+'|import\('@aiqadam/qadam-[a-z0-9-]+'\)" \
    "${repo}/packages/server/api/src" "${repo}/packages/server/worker/src" --include='*.ts' \
  | grep -oE '@aiqadam/qadam-[a-z0-9-]+' | sed 's/^@aiqadam\/qadam-//' \
  | while IFS= read -r name; do
      [ -d "${repo}/packages/qadams/community/${name}" ] && echo "$name"
    done | sort -u)

if [ "$dockerfile_names" != "$flavour_check_names" ]; then
  fail "the Dockerfile's kept community qadams ($(echo "$dockerfile_names" | tr '\n' ' ')) and check-image-flavour.sh's ALWAYS_BUNDLED_COMMUNITY ($(echo "$flavour_check_names" | tr '\n' ' ')) disagree — keep both lists identical"
fi

tmp_imported=$(mktemp)
tmp_kept=$(mktemp)
trap 'rm -f "$tmp_imported" "$tmp_kept"' EXIT
printf '%s\n' "$imported_names" | grep -v '^$' > "$tmp_imported" || true
printf '%s\n' "$dockerfile_names" | grep -v '^$' > "$tmp_kept" || true
missing=$(comm -23 "$tmp_imported" "$tmp_kept")
if [ -n "$missing" ]; then
  fail "the server/worker imports community qadam(s) the Dockerfile's slim prune does not keep: $(echo "$missing" | tr '\n' ' ') — add them to the Dockerfile's prune step and to check-image-flavour.sh's ALWAYS_BUNDLED_COMMUNITY"
fi

echo "check-slim-community-deps: ok ($(echo "$dockerfile_names" | tr '\n' ' '))"
