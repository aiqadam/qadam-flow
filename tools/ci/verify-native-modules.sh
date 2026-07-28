#!/usr/bin/env bash
#
# Prove the natively-compiled dependencies actually load and run.
#
#   tools/ci/verify-native-modules.sh
#
# This exists because caching a BUILT node_modules tree (#155) means CI can now
# start from `.node` binaries it did not produce in this job, and neither test
# suite would notice a bad one:
#
#   * packages/server/api/vitest.config.ts aliases `isolated-vm` to
#     __mocks__/isolated-vm.js, so the CE integration suite provably never
#     loads the real addon.
#   * packages/server/engine/src/lib/core/code/v8-isolate-code-sandbox.ts
#     `require()`s it lazily and only on the V8 sandbox path.
#
# So a green pipeline is not evidence the addon works — that was already
# recorded on #155 before any cache existed. With a restored tree it stops
# being a curiosity and becomes the failure mode worth guarding, so this runs
# straight after install in every job that installs.
#
# It is deliberately unconditional rather than `if: cache-hit`. A cold install
# has to establish that what gets SAVED into the cache is good, otherwise the
# first bad build is published to every later job.
#
# Both addons pick their binary by ABI, platform and libc — the shipped files
# are literally named `isolated-vm.abi137.glibc.node`, `...abi147.musl.node`,
# per-arch. That is the same set of inputs the cache key pins, and this script
# is the runtime check that the pinning held.

set -euo pipefail

node -e '
const ivm = require("isolated-vm");
const isolate = new ivm.Isolate({ memoryLimit: 16 });
try {
  const result = isolate.createContextSync().evalSync("1 + 1");
  if (result !== 2) {
    throw new Error(`isolated-vm evaluated 1 + 1 as ${result}`);
  }
} finally {
  isolate.dispose();
}

const sqlite3 = require("sqlite3");
if (typeof sqlite3.Database !== "function") {
  throw new Error("sqlite3 loaded but exposes no Database constructor");
}

console.log(`native addons OK (node ${process.version}, ABI ${process.versions.modules}, ${process.platform}/${process.arch})`);
'
