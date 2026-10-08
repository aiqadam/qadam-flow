#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-qadam-shared-imports.mjs — ADR-0001 gate 6 (qadams do not
# import @aiqadam/shared). One fixture tree per case under --root, so each import form is shown
# to be caught on its own, a lint-disable comment is shown not to hide it, and the look-alikes
# (the SDK packages, tests, a comment, a similar package name) are shown not to trip it.
# Needs `typescript` from node_modules, so it runs after install in _verify.yml.
#
#   tools/ci/test-qadam-shared-imports-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-qadam-shared-imports.mjs"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0

# tree <name> <relative-file> <content> — a minimal tree with one clean qadam plus the given file.
tree() {
  local dir="${tmp}/$1"
  mkdir -p "$dir/packages/qadams/core/clean/src" "$(dirname "$dir/$2")"
  printf "import { createQadam } from '@aiqadam/qadams-framework'\n" > "$dir/packages/qadams/core/clean/src/index.ts"
  printf '%s\n' "$3" > "$dir/$2"
  printf '%s\n' "$dir"
}

expect() {
  local want="$1" label="$2" dir="$3" needle="${4:-}" out got
  out="$(timeout 60 node "$checker" --root "$dir" 2>&1)"
  got=$?
  if [ "$got" -ne "$want" ] || { [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF -- "$needle"; }; then
    fail=$((fail + 1))
    printf 'FAIL  %s (want %s, got %s)\n' "$label" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/        | /'
    return
  fi
  pass=$((pass + 1))
}

Q='packages/qadams/community/demo/src/index.ts'

echo "== every import form is caught =="
expect 1 'named import' "$(tree named "$Q" "import { isNil } from '@aiqadam/shared'")" "$Q:1"
expect 1 'type-only import' "$(tree type-only "$Q" "import type { QadamCategory } from '@aiqadam/shared'")" "$Q:1"
expect 1 'side-effect import' "$(tree side-effect "$Q" "import '@aiqadam/shared'")" "$Q:1"
expect 1 're-export' "$(tree reexport "$Q" "export { isNil } from '@aiqadam/shared'")" "$Q:1"
expect 1 'export star' "$(tree export-star "$Q" "export * from '@aiqadam/shared'")" "$Q:1"
expect 1 'deep subpath' "$(tree subpath "$Q" "import { x } from '@aiqadam/shared/src/lib/x'")" '@aiqadam/shared/src/lib/x'
expect 1 'require()' "$(tree require "$Q" "const shared = require('@aiqadam/shared')")" "$Q:1"
expect 1 'import = require()' "$(tree import-equals "$Q" "import shared = require('@aiqadam/shared')")" "$Q:1"
expect 1 'dynamic import()' "$(tree dynamic "$Q" "export const load = () => import('@aiqadam/shared')")" "$Q:1"
expect 1 'import type node' "$(tree import-type "$Q" "export type C = import('@aiqadam/shared').QadamCategory")" "$Q:1"
expect 1 'a core qadam, in a nested file' "$(tree nested packages/qadams/core/x/src/lib/a/b.ts "import { isNil } from '@aiqadam/shared'")" 'packages/qadams/core/x/src/lib/a/b.ts:1'
expect 1 'an eslint-disable comment does not hide it (the point of a second check)' \
  "$(tree eslint-disable "$Q" $'// eslint-disable-next-line no-restricted-imports\nimport { isNil } from \'@aiqadam/shared\'')" "$Q:2"

echo "== look-alikes pass =="
expect 0 'the framework itself may use shared (it bundles it into its tarball, #799)' "$(tree framework packages/qadams/framework/src/index.ts "import { isNil } from '@aiqadam/shared'")" 'OK'
expect 0 'common is out of scope (its tarball is checked at publish instead, #799)' "$(tree common packages/qadams/common/src/index.ts "import { isNil } from '@aiqadam/shared'")" 'OK'
expect 1 'a qadam test file is in scope (15 core qadams lint only src/)' "$(tree test packages/qadams/core/csv/test/a.test.ts "import { isNil } from '@aiqadam/shared'")" 'packages/qadams/core/csv/test/a.test.ts:1'
expect 1 'a custom qadam is in scope' "$(tree custom packages/qadams/custom/mine/src/index.ts "import { isNil } from '@aiqadam/shared'")" 'packages/qadams/custom/mine/src/index.ts:1'
expect 0 'a vitest alias key naming the package is not an import' "$(tree alias packages/qadams/core/csv/vitest.config.ts "export default { resolve: { alias: { '@aiqadam/shared': '../../shared/src/index.ts' } } }")" 'OK'
expect 0 'built output in dist/ is not scanned' "$(tree dist packages/qadams/core/csv/dist/src/index.js "require('@aiqadam/shared')")" 'OK'
expect 0 'a comment mentioning the name' "$(tree comment "$Q" "// we used to import from '@aiqadam/shared'")" 'OK'
expect 0 'a string mentioning the name' "$(tree string "$Q" "export const note = \"@aiqadam/shared is private now\"")" 'OK'
expect 0 'a similarly named package' "$(tree similar "$Q" "import { x } from '@aiqadam/shared-utils'")" 'OK'
expect 0 'the framework re-export is the sanctioned path' "$(tree framework-import "$Q" "import { isNil } from '@aiqadam/qadams-framework'")" 'OK'

echo "== UNKNOWN =="
mkdir -p "$tmp/empty/packages"
expect 2 'no qadam sources at all -> UNKNOWN, never a clean pass' "$tmp/empty" 'UNKNOWN'
bare_root_out="$(timeout 60 node "$checker" --root 2>&1)"; bare_root_rc=$?
if [ "$bare_root_rc" -eq 2 ] && printf '%s' "$bare_root_out" | grep -qF 'UNKNOWN'; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); printf 'FAIL  a bare --root -> UNKNOWN, not a crash (want 2, got %s)\n' "$bare_root_rc"
  printf '%s\n' "$bare_root_out" | sed 's/^/        | /'
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
