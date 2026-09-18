#!/usr/bin/env bash
#
# Fixture tests for the StaticDropdown/StaticMultiSelectDropdown defaultValue scan (#427).
#
# The checker is a static AST scan, not a runtime import of built qadams — see the header
# comment in check-dropdown-defaults.mjs for why. These fixtures pin both the cases it must
# catch (a literal defaultValue absent from a literal options list) and the cases it must stay
# silent on (anything it cannot statically resolve), since a false positive there would block
# every PR touching a dynamically-built dropdown.
#
# Run from the "Lint + unit test suite" job (it only needs node + the workspace deps).
#
#   tools/ci/test-dropdown-defaults-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-dropdown-defaults.mjs"

pass=0
fail=0

cleanup() {
  [ -n "${root:-}" ] && rm -rf "$root"
  return 0
}
trap cleanup EXIT

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

new_root() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "$root/packages/qadams/community/demo-qadam/src/lib/actions"
  mkdir -p "$root/packages/qadams/core/demo-core-qadam/src/lib/actions"
}

write_action() {
  # $1 = file path, $2 = props block source
  cat > "$1" <<EOF
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
$2
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
}

run_check() {
  out="$(node "$checker" --root "$root" 2>&1)"
  status=$?
}

expect_status() {
  if [ "$status" -eq "$1" ]; then
    ok
  else
    bad "expected exit $1, got $status — $2\n$out"
  fi
}

expect_contains() {
  case "$out" in
    *"$1"*) ok ;;
    *) bad "expected output to contain '$1' — $2\n$out" ;;
  esac
}

expect_not_contains() {
  case "$out" in
    *"$1"*) bad "expected output NOT to contain '$1' — $2\n$out" ;;
    *) ok ;;
  esac
}

echo "== a consistent tree passes =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: true,
      defaultValue: 'inline',
      options: {
        options: [
          { label: 'Queue', value: 'queue' },
          { label: 'Inline', value: 'inline' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 0 "matching literal default"
expect_contains "no defaultValue/options mismatches found" "matching literal default"

echo "== a mismatched literal default is caught =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    visibility: Property.StaticDropdown({
      displayName: 'Visibility',
      required: true,
      defaultValue: 'public',
      options: {
        options: [
          { label: 'Public', value: 'PUBLIC' },
          { label: 'Private', value: 'PRIVATE' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 1 "case-mismatched default"
expect_contains "1 defaultValue/options mismatch" "case-mismatched default"
expect_contains "demo.ts" "violation names the file"
expect_contains "\"public\"" "violation names the offending default"
# Pins the path.relative(root, file) fix. `expect_contains` is a plain substring match, so
# asserting the clean relative path is present is NOT a regression test on its own — that
# substring is also present inside the broken "../../../tmp/tmp.XXXX/packages/..." output, so it
# would pass either way (measured: reverting the fix to path.relative(REPO_ROOT, file) still
# passes that assertion). A bare `expect_not_contains ".."` isn't safe either — it depends on
# $root itself containing no "..", which holds for mktemp's usual /tmp but silently stops
# catching the regression if TMPDIR points inside this repo (measured). The checker's own
# formatter (check-dropdown-defaults.mjs) prints each violation as two spaces + the relative
# path, so anchoring on that exact prefix is root-position independent — measured to fail under
# the reverted fix with TMPDIR both inside and outside the repo, and pass with the fix in both.
expect_contains "  packages/qadams/community/demo-qadam/src/lib/actions/demo.ts:" "reported path names the fixture file, anchored on the formatter's own two-space indent"

echo "== a numeric default missing from its own options is caught =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    version: Property.StaticDropdown({
      displayName: 'Version',
      required: false,
      defaultValue: 0,
      options: {
        options: [
          { label: 'v1', value: 1 },
          { label: 'v2', value: 2 },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 1 "numeric default absent from options"
expect_contains "1 defaultValue/options mismatch" "numeric default absent from options"

echo "== core qadams are scanned too =="

new_root
write_action "$root/packages/qadams/core/demo-core-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    delimiter: Property.StaticDropdown({
      displayName: 'Delimiter',
      required: true,
      defaultValue: '',
      options: {
        options: [
          { label: 'Comma', value: ',' },
          { label: 'Tab', value: '\t' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 1 "core qadam with a mismatched default"
expect_contains "demo-core-qadam" "core qadam path is reported"
expect_contains "  packages/qadams/core/demo-core-qadam/src/lib/actions/demo.ts:" "core qadam path names the fixture file, anchored on the formatter's own two-space indent"

echo "== STATIC_MULTI_SELECT_DROPDOWN checks every entry in the default array =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    tags: Property.StaticMultiSelectDropdown({
      displayName: 'Tags',
      required: false,
      defaultValue: ['a', 'z'],
      options: {
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 1 "multi-select default has one entry outside the declared options"
expect_contains "1 defaultValue/options mismatch" "multi-select default has one entry outside the declared options"

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    tags: Property.StaticMultiSelectDropdown({
      displayName: 'Tags',
      required: false,
      defaultValue: ['a', 'b'],
      options: {
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 0 "multi-select default fully covered by declared options"

echo "== nothing statically resolvable is skipped, not guessed at =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: true,
      defaultValue: SOME_IMPORTED_CONSTANT,
      options: {
        options: [
          { label: 'Queue', value: 'queue' },
          { label: 'Inline', value: 'inline' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 0 "a non-literal defaultValue is not checked"

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: true,
      defaultValue: 'totally-not-declared',
      options: {
        options: MODES.map((m) => ({ label: m.label, value: m.id })),
      },
    }),
PROPS
)"
run_check
expect_status 0 "options built by .map() are not statically known, so nothing is asserted"

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: true,
      defaultValue: 'totally-not-declared',
      options: DYNAMIC_OPTIONS,
    }),
PROPS
)"
run_check
expect_status 0 "an options reference that is not an object literal is not checked"

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: false,
      options: {
        options: [
          { label: 'Queue', value: 'queue' },
          { label: 'Inline', value: 'inline' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 0 "a dropdown with no defaultValue at all is not checked"

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: false,
      defaultValue: 'anything',
      options: {
        options: [
          { label: 'Computed', value: computeValue() },
          { label: 'Inline', value: 'inline' },
        ],
      },
    }),
PROPS
)"
run_check
expect_status 0 "an option whose value is computed makes the whole list unverifiable, so it is skipped"

echo "== scanning zero files is a loud failure, not a silent pass =="

new_root
# No write_action call: both qadam roots exist (mkdir -p in new_root) but are empty. A checker
# that reports OK here would pass forever if packages/qadams ever moved or got renamed.
run_check
expect_status 1 "an empty tree does not report a false OK"
# "scanned 0 files" alone is hollow: the false-pass message the guard prevents also contains that
# substring ("OK — scanned 0 files, no defaultValue/options mismatches found."), so it would pass
# with the guard removed too (measured). The guard's own message says "files under" where the
# false-pass message says "files, no" — that's what actually distinguishes them.
expect_contains "scanned 0 files under" "the reason is named"
expect_not_contains "OK —" "an empty tree is never reported as a pass"

echo "== a plain Dropdown (dynamic options) is out of scope =="

new_root
write_action "$root/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" "$(cat <<'PROPS'
    mode: Property.Dropdown({
      displayName: 'Mode',
      required: true,
      defaultValue: 'anything-at-all',
      refreshers: [],
      options: async () => ({ options: [] }),
    }),
PROPS
)"
run_check
expect_status 0 "Property.Dropdown is not Property.StaticDropdown"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "dropdown-defaults checker tests FAILED."
  exit 1
fi
echo "dropdown-defaults checker tests passed."
