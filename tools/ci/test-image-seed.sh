#!/usr/bin/env bash
#
# Tests for the image store seed (#807, ADR-0003): tools/scripts/qadams/bundle/build-image-seed.mjs.
#
# Builds a fixture archive containing every core qadam plus one community qadam, then checks that
# `--flavour slim` copies only the core tarballs and that `fat` copies every one. The wrapper reads
# the core package names from the repository, so the fixture mirrors the real build layout without
# running 238 npm packs.
#
#   tools/ci/test-image-seed.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
builder="${repo}/tools/scripts/qadams/bundle/build-image-seed.mjs"

pass=0
fail=0
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

ok() {
  pass=$((pass + 1))
  printf 'ok    %s\n' "$1"
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

expect_exit() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then ok "$name (exit $actual)"; else bad "$name: expected exit $expected, got $actual"; fi
}

archive="${root}/archive"
mkdir -p "$archive"

REPO="$repo" ARCHIVE="$archive" node --input-type=module - <<'EOF'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.env.REPO
const archive = process.env.ARCHIVE
const coreDir = join(repo, 'packages', 'qadams', 'core')
const core = readdirSync(coreDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(join(coreDir, entry.name, 'package.json'), 'utf8')).name)

const artifacts = []
let index = 0
const add = ({ name, file }) => {
  writeFileSync(join(archive, file), `${name}\n`)
  artifacts.push({ name, version: '1.0.0', kind: 'bundle', file, integrity: 'sha512-fixture', shasum: 'fixture', size: 1, commit: '0'.repeat(40) })
}
for (const name of core) {
  add({ name, file: `core-${index++}.tgz` })
}
add({ name: '@aiqadam/qadam-community-fixture', file: 'community-fixture.tgz' })
writeFileSync(join(archive, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts }, null, 2) + '\n')
writeFileSync(join(archive, 'expected-core-count'), `${core.length}\n`)
EOF

expected_core="$(cat "${archive}/expected-core-count")"

node "$builder" --archive "$archive" --out "${root}/slim" --flavour slim --repo "$repo" >"${root}/slim.log" 2>&1
expect_exit "builds the slim seed" 0 $?

SLIM="${root}/slim" EXPECTED_CORE="$expected_core" node --input-type=module - <<'EOF'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.SLIM
const expected = Number(process.env.EXPECTED_CORE)
const index = JSON.parse(readFileSync(join(dir, 'archive-index.json'), 'utf8'))
const failures = []
if (index.artifacts.length !== expected) failures.push(`expected ${expected} artifacts, got ${index.artifacts.length}`)
if (index.artifacts.some((artifact) => artifact.name === '@aiqadam/qadam-community-fixture')) failures.push('kept the community artifact')
const tarballs = readdirSync(dir).filter((file) => file.endsWith('.tgz'))
if (tarballs.length !== expected) failures.push(`expected ${expected} tarballs, got ${tarballs.length}`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
EOF
expect_exit "slim keeps only the core qadams" 0 $?

node "$builder" --archive "$archive" --out "${root}/fat" --flavour fat --repo "$repo" >"${root}/fat.log" 2>&1
expect_exit "builds the fat seed" 0 $?

FAT="${root}/fat" EXPECTED_CORE="$expected_core" node --input-type=module - <<'EOF'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAT
const expected = Number(process.env.EXPECTED_CORE) + 1
const index = JSON.parse(readFileSync(join(dir, 'archive-index.json'), 'utf8'))
const failures = []
if (index.artifacts.length !== expected) failures.push(`expected ${expected} artifacts, got ${index.artifacts.length}`)
if (!index.artifacts.some((artifact) => artifact.name === '@aiqadam/qadam-community-fixture')) failures.push('dropped the community artifact')
const tarballs = readdirSync(dir).filter((file) => file.endsWith('.tgz'))
if (tarballs.length !== expected) failures.push(`expected ${expected} tarballs, got ${tarballs.length}`)
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
EOF
expect_exit "fat keeps every official qadam" 0 $?

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
