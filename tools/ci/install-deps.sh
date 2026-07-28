#!/usr/bin/env bash
#
# Install dependencies in CI, on top of a possibly-restored node_modules cache.
#
#   tools/ci/install-deps.sh
#
# Both installing jobs (`_verify.yml`'s `verify` and `ci.yml`'s
# `integration-run`) call this so the retry semantics cannot drift between
# them. It is deliberately run AFTER `actions/cache/restore`, and it always
# runs `bun install --frozen-lockfile` even on a cache hit: the restored tree
# is a starting point, never the verdict. bun reconciles whatever it finds
# against bun.lock, and `--frozen-lockfile` turns any divergence into a hard
# failure instead of a silent mutation. A stale or truncated restore therefore
# costs time, not correctness.
#
# The retry is the one thing the restore makes MORE important, not less. Before
# the cache, `node_modules` was always empty at job start, so the only poisoned
# input a retry could clear was bun's download cache — and #157 measured that
# bun already refetches bad entries itself, making that handler unreachable via
# cache corruption. Now a *built* tree arrives pre-warmed, so "wipe it and
# install clean" is a real recovery path, and the retry wipes both.
#
# See #155 for why this caches build output rather than bun's download cache.

set -uo pipefail

# Removes every node_modules directory that `bun install` produces, and only
# those. The `-maxdepth 4` under packages/ is load-bearing, not a guess: it
# covers packages/*/, packages/server/*/ and packages/qadams/*/*/ (the deepest
# workspace glob in package.json), and stops short of
# packages/server/engine/test/resources/codes/flowVersionId/hello_world_npm/node_modules,
# which is a TRACKED git fixture, not an install artifact. A bare
# `find . -name node_modules -delete` would delete it and break the engine
# tests. Keep this list in sync with the cache `path:` globs in the workflows.
clean_installed_node_modules() {
  rm -rf node_modules
  find packages -maxdepth 4 -name node_modules -type d -prune -exec rm -rf {} +
}

if bun install --frozen-lockfile; then
  exit 0
fi

echo "::warning::bun install failed. Discarding the restored node_modules and bun's download cache, then installing from scratch."
clean_installed_node_modules
rm -rf ~/.bun/install/cache
bun install --frozen-lockfile
