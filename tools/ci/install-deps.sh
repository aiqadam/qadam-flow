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

  # Environment that changes what the install PRODUCES. The cache key hashes THIS FILE, so a change
  # here always changes the key — install behaviour and cache identity move together by construction.
  #
  # This was briefly a separate tools/ci/install.env, parsed by hand, so that editing this script's
  # prose would not cost every branch a cold rebuild. That traded a real 3-minute cost for a
  # hand-written shell parser, and three review rounds found three fail-open defects in it, each one
  # able to apply half an environment and return 0 — precisely the failure the separation existed to
  # prevent. A conservative key is the cheaper trade: an occasional needless cold install, and no
  # parser to be wrong.
  #
  # redis-memory-server's postinstall downloads a Redis binary and compiles Redis from source when
  # that download fails. The compile is broken, so the postinstall exits 1 and takes the whole install
  # with it (invisible until a PR touched bun.lock, because until then every run restored a cache hit and bun re-ran no install scripts — see the cache-key comment in .github/workflows/_verify.yml). Nothing in
  # CI uses those binaries: tests run against a real Redis service (packages/server/api/.env.tests sets
  # AP_REDIS_TYPE=STANDALONE on 127.0.0.1:6379), the integration job starts one, and no test constructs
  # RedisMemoryServer. Skipping the compile is the fix, not a workaround. The Dockerfile sets the same
  # variable independently in its `base` stage, since it has three bun install calls and cannot read
  # this file.
  # Exported, not prefixed onto the command: the retry below is a second `bun install` in this same
  # shell, and a prefix would cover only the first attempt. Collapsing this to
  # `REDISMS_DISABLE_POSTINSTALL=1 bun install …` would leave the retry running the broken postinstall
  # again — the hardest failure mode to spot, because the first attempt would still pass.
  export REDISMS_DISABLE_POSTINSTALL=1

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
