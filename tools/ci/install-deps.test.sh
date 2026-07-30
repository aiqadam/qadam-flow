#!/usr/bin/env bash
#
# Tests for tools/ci/install-deps.sh (#155).
#
#   tools/ci/install-deps.test.sh
#
# Two things are covered, and the second is the reason this file exists.
#
# 1. `clean_installed_node_modules` is an unguarded recursive delete. It must
#    remove every node_modules directory `bun install` produces and must NOT
#    remove packages/server/engine/test/resources/codes/flowVersionId/
#    hello_world_npm/node_modules, which is tracked in git.
#
# 2. The only thing standing between (1) and eating that fixture is a depth
#    bound that has to stay equal to the deepest cache `path:` glob in BOTH
#    _verify.yml and ci.yml — six places, in three files, previously kept in
#    agreement by nothing but comments asking a human to. Widening a glob to
#    `packages/*/*/*/*/node_modules` without touching the delete, or vice
#    versa, is the realistic drift, and case set 2 fails on it.
#
# Runs in the unconditional `Lint + Unit Tests` job, like the other tools/ci
# suites: it guards a destructive script that every install in CI executes.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# Sourcing gives us the function and INSTALL_NODE_MODULES_MAXDEPTH without
# running an install — the script guards its own main on BASH_SOURCE.
# shellcheck source=./install-deps.sh
. "${here}/install-deps.sh"

echo "== the delete removes install output and spares the tracked fixture =="

fixture_rel="packages/server/engine/test/resources/codes/flowVersionId/hello_world_npm/node_modules"

# Every depth the cache globs claim to cover, one directory each, plus the
# tracked fixture that sits one level deeper than the bound.
install_dirs=(
  "node_modules"                              # root, hoisted store lives here
  "packages/web/node_modules"                 # packages/*/
  "packages/server/api/node_modules"          # packages/*/*/
  "packages/qadams/community/foo/node_modules" # packages/*/*/*/
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for d in "${install_dirs[@]}" "$fixture_rel"; do
  mkdir -p "${tmp}/${d}"
  printf 'sentinel\n' > "${tmp}/${d}/sentinel.txt"
done

clean_installed_node_modules "$tmp"

for d in "${install_dirs[@]}"; do
  if [ -e "${tmp}/${d}" ]; then
    bad "install dir survived the delete: ${d}"
  else
    ok
  fi
done

if [ -f "${tmp}/${fixture_rel}/sentinel.txt" ]; then
  ok
else
  bad "TRACKED fixture was deleted: ${fixture_rel}"
fi

# A delete that silently does nothing would pass the two checks above if the
# tree were built wrong, so assert the fixture really is deeper than the bound.
fixture_find_depth="$(printf '%s' "${fixture_rel#packages/}" | tr -cd '/' | wc -c)"
fixture_find_depth=$((fixture_find_depth + 1))
if [ "$fixture_find_depth" -gt "$INSTALL_NODE_MODULES_MAXDEPTH" ]; then
  ok
else
  bad "fixture at find-depth ${fixture_find_depth} is not deeper than -maxdepth ${INSTALL_NODE_MODULES_MAXDEPTH}; the spare above proves nothing"
fi

# The fixture must still be tracked for any of this to matter. If someone
# deletes it from git, this suite should say so rather than keep guarding it.
if git -C "$repo_root" ls-files --error-unmatch "${fixture_rel}/hello-world-npm/index.js" >/dev/null 2>&1; then
  ok
else
  bad "expected ${fixture_rel}/hello-world-npm/index.js to be tracked in git; update this test or the delete bound"
fi

echo "== the cache globs agree with the delete's depth bound =="

# Pulls the `<...>node_modules` glob lines out of a workflow's cache `path:`
# blocks. Both cache steps in a file share one glob list, so duplicates are
# expected and collapsed.
workflow_globs() {
  local file="$1"
  grep -oE '^ +(node_modules|packages(/\*)+/node_modules)$' "$file" \
    | tr -d ' ' | sort -u
}

expected_globs="$(
  {
    printf 'node_modules\n'
    prefix="packages"
    for _ in $(seq 1 $((INSTALL_NODE_MODULES_MAXDEPTH - 1))); do
      prefix="${prefix}/*"
      printf '%s/node_modules\n' "$prefix"
    done
  } | sort -u
)"

for wf in "${repo_root}/.github/workflows/_verify.yml" "${repo_root}/.github/workflows/ci.yml"; do
  got="$(workflow_globs "$wf")"
  if [ "$got" = "$expected_globs" ]; then
    ok
  else
    bad "cache path globs in $(basename "$wf") do not match -maxdepth ${INSTALL_NODE_MODULES_MAXDEPTH}"
    printf '  want:\n%s\n  got:\n%s\n' "$expected_globs" "$got"
  fi
done

# The globs are worth nothing if they are not actually on a cache step, so
# confirm each workflow still wires them to actions/cache.
for wf in "${repo_root}/.github/workflows/_verify.yml" "${repo_root}/.github/workflows/ci.yml"; do
  if grep -q 'actions/cache/restore@' "$wf"; then
    ok
  else
    bad "$(basename "$wf") has no actions/cache/restore step; the globs above are dead"
  fi
done

echo "== every tree-content input is in the cache key =="

# The key claims to cover everything that can change the tree's contents. These
# are the repo-root files bun reads; .npmrc was missing from the first version
# of the key even though it sets a scoped registry and legacy-peer-deps.
# tools/ci/install-deps.sh is here because it sets the environment the install runs
# under, and while nothing hashed it a tree built under different install behaviour
# was served from cache with no symptom. Hashing the script means editing its comments
# costs a needless cold install; that is the accepted price for the key never lagging
# behind install behaviour.
for wf in "${repo_root}/.github/workflows/_verify.yml" "${repo_root}/.github/workflows/ci.yml"; do
  for input in bun.lock bunfig.toml package.json .npmrc tools/ci/install-deps.sh; do
    if grep -q "hashFiles(.*'${input}'" "$wf"; then
      ok
    else
      bad "$(basename "$wf") cache key does not hash ${input}"
    fi
  done
done

echo "== the two workflows compute the SAME cache key =="

# Asserting each input appears in both files is not enough: the rest of the key is duplicated prose
# (epoch expression, os/arch, resolved node and bun versions), and nothing stopped the two from
# drifting. If they drift, `integration-run` misses every entry `verify` saves and cold-installs
# forever while reporting green — "the inputs turbo hashed did not change" dressed up as a pass.
# Compared verbatim rather than per-component, so any future divergence fails here.
#
# `sort -u` because a file may legitimately carry the key more than once — ci.yml has one
# restore step per installing job (`integration-run`, `e2e`). Collapsing duplicates keeps
# that from reading as a mismatch, and does NOT weaken the check: two keys that differ
# survive the dedup as two lines and still fail the comparison below.
key_lines() {
  grep -h "^ *key: node-modules-" "$1" | sed 's/^ *//' | sort -u
}

verify_key="$(key_lines "${repo_root}/.github/workflows/_verify.yml")"
ci_key="$(key_lines "${repo_root}/.github/workflows/ci.yml")"
if [ -z "$verify_key" ] || [ -z "$ci_key" ]; then
  # an empty match is unknown, not a pass
  bad "could not find a node-modules cache key line in one or both workflows"
elif [ "$verify_key" = "$ci_key" ]; then
  ok
else
  bad "the cache keys in _verify.yml and ci.yml differ; integration-run will never restore what verify saves"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
