#!/usr/bin/env bash
#
# Install dependencies in CI, on top of a possibly-restored node_modules cache.
#
#   tools/ci/install-deps.sh
#
# Both installing jobs (`_verify.yml`'s `verify` and `ci.yml`'s
# `integration-run`) call this so the retry semantics cannot drift between
# them. It runs AFTER `actions/cache/restore`, and it always runs
# `bun install --frozen-lockfile` even on a cache hit.
#
# Be precise about what that buys, because the boundary matters more than the
# reassurance: `--frozen-lockfile` asserts that resolution does not need to
# change the lockfile. It is NOT an integrity check on the restored files. bun
# will not re-extract or re-run install scripts for a package it already sees
# present at the expected version, so a restored directory whose *contents* are
# corrupt at the right version is invisible to this step.
#
# What actually keeps a restored tree honest is therefore, in order:
#   1. the exact-match cache key — every tree-content input is in it, with no
#      `restore-keys` fallback, so a tree built under different inputs is
#      unreachable rather than merely unlikely;
#   2. tools/ci/verify-native-modules.sh, which loads the compiled addons and
#      is the only step that can observe a corrupt-but-right-version restore;
#   3. this retry, which turns a tree bun *does* choke on into one slow but
#      green run instead of red CI until someone bumps the key's epoch.
#
# That retry is the one thing the restore makes MORE important, not less.
# Before the cache, node_modules was always empty at job start, so the only
# poisoned input a retry could clear was bun's download cache — and #157
# measured that bun already refetches bad entries itself, making the old
# handler unreachable via cache corruption. Now a *built* tree arrives
# pre-warmed, so "wipe it and install clean" is a real recovery path.
#
# See #155 for why this caches build output rather than bun's download cache.

set -uo pipefail

# Every node_modules directory `bun install` creates lives at most this many
# levels below packages/ — `packages/qadams/community/*/node_modules` is the
# deepest, matching the deepest workspace glob in package.json.
#
# The bound is load-bearing, not tidiness. One level further down sits
# packages/server/engine/test/resources/codes/flowVersionId/hello_world_npm/
# node_modules, a TRACKED git fixture rather than an install artifact; a bare
# `find . -name node_modules -delete` would eat it and break the engine tests.
# It must also stay equal to the deepest cache `path:` glob in _verify.yml and
# ci.yml. tools/ci/install-deps.test.sh asserts all three agree, so that is
# checked rather than merely requested in a comment.
readonly INSTALL_NODE_MODULES_MAXDEPTH=4

# Takes its root explicitly instead of trusting the caller's cwd: this is a
# recursive delete, and every other script in tools/ci/ resolves its own paths
# rather than depending on how it was invoked.
clean_installed_node_modules() {
  local root="$1"

  rm -rf "${root}/node_modules"
  if [ -d "${root}/packages" ]; then
    find "${root}/packages" -maxdepth "$INSTALL_NODE_MODULES_MAXDEPTH" \
      -name node_modules -type d -prune -exec rm -rf {} +
  fi
}

main() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1
  cd "$repo_root" || exit 1

  # Environment that changes what the install PRODUCES lives in tools/ci/install.env, which the cache
  # key hashes — so changing a value there invalidates the cache, while editing this script's prose
  # does not. Do not move these exports back into this file; that is what made a stale tree
  # invisible. Sourced with `set -a` so every assignment is exported to both installs below.
  # Both failure modes must stop the install, not just a missing file: this script runs under
  # `set -uo pipefail` with no `-e`, so a file that exists but fails to source (bad permissions, an
  # unquoted value with a space) would partially apply its assignments and fall straight through to
  # the install — producing a tree that does not match the key it gets saved under, which is the exact
  # hole this file was added to close.
  if [ ! -f tools/ci/install.env ]; then
    echo "::error::tools/ci/install.env is missing. It carries the install-affecting environment and is part of the cache key; a tree built without it is not the tree the key describes."
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  if ! . tools/ci/install.env; then
    set +a
    echo "::error::tools/ci/install.env exists but could not be sourced. Refusing to install under a partially-applied environment."
    exit 1
  fi
  set +a

  if bun install --frozen-lockfile; then
    exit 0
  fi

  echo "::warning::bun install failed. Discarding the restored node_modules and bun's download cache, then installing from scratch."
  clean_installed_node_modules "$repo_root"
  rm -rf ~/.bun/install/cache
  bun install --frozen-lockfile
}

# Sourceable, so install-deps.test.sh can exercise the delete against a
# synthetic tree without running an install.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
