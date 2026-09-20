#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-required-prop-defaults.mjs (#479): a required prop with no
# `defaultValue` added to an already-shipped action/trigger, without a paired MAJOR bump of the
# qadam's own package.json in the same range.
#
# Modeled on tools/ci/test-breaking-change-gate.sh's convention, not check-dropdown-defaults's
# `--root` fixture style: the checker under test reads two git commits (PR_BASE_SHA/PR_HEAD_SHA),
# not one tree, so the fixtures are real throwaway git repos with a real "before" and "after"
# commit — nothing about the diff or `git show` is stubbed, because the checker's whole job is
# reading those.
#
# A code-quality review of an earlier version of this suite found it stayed green under four
# separate mutations (dropping the `headProp.resolvable`/`baseProp.resolvable`/`NOT_STATIC` guards,
# and dropping `--diff-filter=M`), and that three of its cases passed for the wrong reason. Every
# case below exists to make one specific guard load-bearing — if you touch the checker, re-run
# this file AND deliberately break the guard the case names in its comment to confirm it goes red.
#
#   tools/ci/test-required-prop-defaults-check.sh

set -uo pipefail

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-required-prop-defaults.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
last_out=''

ok() { pass=$((pass + 1)); }

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
  printf '        --- checker output ---\n'
  printf '%s\n' "$last_out" | sed 's/^/        | /'
}

new_repo() {
  local dir="${tmp}/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.name 'Fixture Author'
  git -C "$dir" config user.email 'fixture@example.invalid'
  git -C "$dir" config commit.gpgsign false
  printf '%s\n' "$dir"
}

# write_qadam <dir> <root:community|core> <name> <version> <props-block> [factory:createAction|createTrigger]
write_qadam() {
  local dir="$1" root="$2" name="$3" version="$4" props="$5" factory="${6:-createAction}"
  local qadam_dir="${dir}/packages/qadams/${root}/${name}"
  mkdir -p "${qadam_dir}/src/lib/actions"
  cat > "${qadam_dir}/package.json" <<EOF
{
  "name": "@aiqadam/qadam-${name}",
  "version": "${version}"
}
EOF
  local extra=''
  if [ "$factory" = 'createTrigger' ]; then
    extra="  type: 'POLLING',
  sampleData: {},"
  fi
  cat > "${qadam_dir}/src/lib/actions/demo.ts" <<EOF
import { ${factory}, Property } from '@aiqadam/qadams-framework';

export const demoAction = ${factory}({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
${extra}
  props: {
${props}
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
}

# write_common_helper <dir> <version> <props-block> — mirrors the REAL packages/qadams/common
# layout: one package.json for the whole directory, source under src/lib/helpers/, no per-qadam
# subdirectory. This is the exact shape F1 (an earlier version of this checker) got wrong.
#
# Also plants a DECOY package.json at the path an earlier, buggy findPackageJson derived for a
# file under `common` (`<root>/<firstSegment>/package.json`, i.e. `common/src/package.json`),
# pinned to a version that never changes. This is what makes "common must stay out of
# QADAM_ROOTS" an actually falsifiable claim: if `common` were mistakenly added back to
# QADAM_ROOTS, the checker would resolve the decoy's stable, never-majored version instead of the
# real package.json two directories up — a wrong-but-successful read, which the resolvable-version
# skip (the OTHER half of the F1 fix) cannot catch, because the decoy read genuinely succeeds. Only
# actually excluding `common` from QADAM_ROOTS prevents that misread.
write_common_helper() {
  local dir="$1" version="$2" props="$3"
  local common_dir="${dir}/packages/qadams/common"
  mkdir -p "${common_dir}/src/lib/helpers"
  cat > "${common_dir}/package.json" <<EOF
{
  "name": "@aiqadam/qadams-common",
  "version": "${version}"
}
EOF
  cat > "${common_dir}/src/package.json" <<'EOF'
{ "name": "decoy-do-not-read", "version": "0.1.0" }
EOF
  cat > "${common_dir}/src/lib/helpers/index.ts" <<EOF
import { createAction, Property } from '@aiqadam/qadams-framework';

export const customApiCallAction = createAction({
  name: 'custom_api_call',
  displayName: 'Custom API Call',
  description: 'fixture',
  props: {
${props}
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
}

commit_all() {
  local dir="$1" msg="$2"
  git -C "$dir" add -A
  git -C "$dir" commit -q --no-gpg-sign -m "$msg"
}

# build_case <name> <root> <base-version> <base-props> <head-version> <head-props> [factory]
# Returns "dir base_sha head_sha" on stdout.
build_case() {
  local name="$1" root="$2" base_version="$3" base_props="$4" head_version="$5" head_props="$6" factory="${7:-createAction}"
  local dir
  dir="$(new_repo "$name")"
  write_qadam "$dir" "$root" demo-qadam "$base_version" "$base_props" "$factory"
  commit_all "$dir" 'feat: baseline'
  local base_sha head_sha
  base_sha="$(git -C "$dir" rev-parse HEAD)"
  write_qadam "$dir" "$root" demo-qadam "$head_version" "$head_props" "$factory"
  commit_all "$dir" 'feat: change props'
  head_sha="$(git -C "$dir" rev-parse HEAD)"
  printf '%s %s %s\n' "$dir" "$base_sha" "$head_sha"
}

run_check() {
  local dir="$1" base="$2" head="$3"
  last_out="$(cd "$dir" && PR_BASE_SHA="$base" PR_HEAD_SHA="$head" node "$checker" 2>&1)"
  status=$?
}

expect_status() {
  if [ "$status" -eq "$1" ]; then
    ok
  else
    fail_case "$2" "expected exit $1, got $status"
  fi
}

expect_contains() {
  case "$last_out" in
    *"$1"*) ok ;;
    *) fail_case "$2" "expected output to contain '$1'" ;;
  esac
}

expect_not_contains() {
  case "$last_out" in
    *"$1"*) fail_case "$2" "expected output NOT to contain '$1'" ;;
    *) ok ;;
  esac
}

# Counts non-overlapping occurrences of a fixed substring.
count_occurrences() {
  local haystack="$1" needle="$2"
  printf '%s' "$haystack" | grep -o -F -- "$needle" | wc -l | tr -d ' '
}

echo "== a newly-required prop with no default and no major bump is caught =="

read -r dir base head <<< "$(build_case reject-new-required community 0.1.0 \
"    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: false,
      options: { options: [{ label: 'Queue', value: 'queue' }] },
    })," \
0.1.1 \
"    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: false,
      options: { options: [{ label: 'Queue', value: 'queue' }] },
    }),
    execution_mode: Property.ShortText({
      displayName: 'Execution Mode',
      required: true,
    }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "new required-no-default prop, patch bump only -> FAIL"
expect_contains "execution_mode" "violation names the new prop"
expect_contains "'demo_action'" "violation names the owning action"
expect_contains "0.1.0 -> 0.1.1" "violation names the version pair"
expect_not_contains "'mode'" "the untouched, still-optional 'mode' prop is not itself flagged"

echo "== the same change, on a createTrigger, is caught the same way =="

read -r dir base head <<< "$(build_case reject-new-required-trigger community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true })," \
createTrigger)"
run_check "$dir" "$base" "$head"
expect_status 1 "createTrigger is scanned, not just createAction"

echo "== the same change, paired with a MAJOR bump, passes =="

read -r dir base head <<< "$(build_case accept-major-bump community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
1.0.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "same new required-no-default prop, but package.json majored in the same range -> PASS"

echo "== a prop already required-with-no-default before this diff is not re-flagged =="

read -r dir base head <<< "$(build_case accept-preexisting community 0.1.0 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true })," \
0.1.1 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, description: 'unrelated doc tweak' }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "prop was already broken before this diff; not introduced by it -> PASS"

echo "== a required prop that carries a real defaultValue is fine =="

read -r dir base head <<< "$(build_case accept-has-default community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: 'queue' }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "new required prop WITH a defaultValue -> PASS"

echo "== a defaultValue of literally undefined does NOT count as a default (F6) =="

read -r dir base head <<< "$(build_case reject-default-undefined community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: undefined }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "defaultValue: undefined is not a real default -> FAIL"

echo "== a defaultValue of literally null does NOT count as a default (F6) =="

read -r dir base head <<< "$(build_case reject-default-null community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: null }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "defaultValue: null is not a real default -> FAIL"

echo "== a defaultValue removed from an already-required prop is caught =="

read -r dir base head <<< "$(build_case reject-default-removed community 0.1.0 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: 'queue' })," \
0.1.1 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "defaultValue dropped from an already-required prop, no major bump -> FAIL"

echo "== (F2a) a call outside Property.*/QadamAuth.* is unresolvable, even with a literal required:true =="

read -r dir base head <<< "$(build_case skip-non-property-namespace community 0.1.0 \
"    chat_id: telegramCommons.chatIdProp({ required: false })," \
0.1.1 \
"    chat_id: telegramCommons.chatIdProp({ required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "a helper call is unresolvable regardless of its own literal required/defaultValue — mutation: dropping the callee-namespace check makes this FAIL"

echo "== (F2b) a spread inside the Property config is unresolvable =="

read -r dir base head <<< "$(build_case skip-spread-in-config community 0.1.0 \
"    mode: Property.ShortText({ ...sharedModeProps, required: false })," \
0.1.1 \
"    mode: Property.ShortText({ ...sharedModeProps, required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "a spread could carry required/defaultValue from elsewhere, so it must stay unresolvable — mutation: dropping the spread hazard check makes this FAIL"

echo "== (F2c) an ES6 'required' shorthand at BASE must not be silently read as required:false =="

# Built by hand rather than via build_case/write_qadam: the shorthand needs a local `required`
# binding declared above the props object literal, which write_qadam's single props-block
# parameter has no way to express.
dir="$(new_repo skip-required-shorthand)"
mkdir -p "${dir}/packages/qadams/community/demo-qadam/src/lib/actions"
cat > "${dir}/packages/qadams/community/demo-qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-demo-qadam", "version": "0.1.0" }
EOF
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

const required = true;

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: baseline with a required shorthand'
base="$(git -C "$dir" rev-parse HEAD)"
cat > "${dir}/packages/qadams/community/demo-qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-demo-qadam", "version": "0.1.1" }
EOF
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: spell out required explicitly, no behaviour change'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "BASE's shorthand 'required' must be unresolvable, not silently read as required:false — mutation: dropping the shorthand hazard check makes this FAIL (a false positive on an unchanged prop)"

echo "== (F2c) an ES6 'defaultValue' shorthand is unresolvable, not silently read as 'no default' =="

dir="$(new_repo skip-defaultvalue-shorthand)"
mkdir -p "${dir}/packages/qadams/community/demo-qadam/src/lib/actions"
cat > "${dir}/packages/qadams/community/demo-qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-demo-qadam", "version": "0.1.0" }
EOF
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    mode: Property.ShortText({ displayName: 'Mode', required: false }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

const defaultValue = 'queue';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: add execution_mode with a shorthand default'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "a defaultValue shorthand must be unresolvable, not silently read as 'no default' — mutation: dropping the shorthand hazard check makes this FAIL (a false positive on a prop that does carry a default)"

echo "== a non-literal 'required: someFlag' is unresolvable, not silently read as required:false =="

dir="$(new_repo skip-non-literal-required)"
mkdir -p "${dir}/packages/qadams/community/demo-qadam/src/lib/actions"
cat > "${dir}/packages/qadams/community/demo-qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-demo-qadam", "version": "0.1.0" }
EOF
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

const isRequiredByFeatureFlag = true;

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: isRequiredByFeatureFlag }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: baseline with a non-literal required'
base="$(git -C "$dir" rev-parse HEAD)"
cat > "${dir}/packages/qadams/community/demo-qadam/package.json" <<'EOF'
{ "name": "@aiqadam/qadam-demo-qadam", "version": "0.1.1" }
EOF
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: spell out required explicitly, no behaviour change'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "BASE's non-literal 'required: isRequiredByFeatureFlag' must be unresolvable, not silently read as required:false — mutation: dropping the NOT_STATIC guard makes this FAIL (a false positive on an unchanged prop)"

echo "== (F3) a brand-new action appended to an already-shipped (Modified) file is out of scope =="

dir="$(new_repo new-action-in-existing-file)"
write_qadam "$dir" community demo-qadam 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),"
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    mode: Property.ShortText({ displayName: 'Mode', required: false }),
  },
  async run(context) {
    return context.propsValue;
  },
});

export const secondAction = createAction({
  name: 'second_action',
  displayName: 'Second Action',
  description: 'fixture',
  props: {
    required_no_default: Property.ShortText({ displayName: 'X', required: true }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: add a second action to the same file'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "a second, never-shipped action in the same Modified file is not this check's concern — mutation: comparing props by file instead of by action name makes this FAIL"

echo "== a brand-new action FILE (Added, not Modified) is also out of scope =="

dir="$(new_repo new-file-out-of-scope)"
write_qadam "$dir" community demo-qadam 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),"
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
mkdir -p "${dir}/packages/qadams/community/demo-qadam/src/lib/actions"
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/second.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const secondAction = createAction({
  name: 'second_action',
  displayName: 'Second Action',
  description: 'fixture',
  props: {
    required_no_default: Property.ShortText({ displayName: 'X', required: true }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
commit_all "$dir" 'feat: add a second action in a new file'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "a required-no-default prop in a brand-new (Added) file is not this check's concern — mutation: dropping --diff-filter=M makes this FAIL"

echo "== (F1) packages/qadams/common is out of scope, even for a real violation shape =="

dir="$(new_repo common-out-of-scope)"
write_common_helper "$dir" 0.14.0 \
"    url: Property.ShortText({ displayName: 'URL', required: false }),"
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
write_common_helper "$dir" 1.0.0 \
"    url: Property.ShortText({ displayName: 'URL', required: false }),
    strict_mode: Property.Checkbox({ displayName: 'Strict', required: true }),"
commit_all "$dir" 'feat: add a required prop to the shared custom-api-call helper'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "common is not scanned at all (documented blind spot), so even a real violation there is silent, and — the actual regression — the checker must not crash or misfire trying to read packages/qadams/common/src/package.json"
expect_not_contains "ENOENT" "no crash trying to resolve a package.json path that cannot exist"
expect_not_contains "package.json" "common is excluded entirely, so no package.json path for it is even considered"

echo "== an unresolvable package.json version at either end is skipped, not flagged as a violation =="

dir="$(new_repo unresolvable-version-must-skip)"
write_qadam "$dir" community demo-qadam 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),"
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
cat > "${dir}/packages/qadams/community/demo-qadam/src/lib/actions/demo.ts" <<'EOF'
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
  description: 'fixture',
  props: {
    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),
  },
  async run(context) {
    return context.propsValue;
  },
});
EOF
# package.json intentionally corrupted (not deleted — a deleted package.json would make the
# checker's own file untouched by the diff, which is a different, less interesting case): readVersion
# must return null here, not crash and not silently read a version out of garbage JSON.
printf 'not valid json{{{\n' > "${dir}/packages/qadams/community/demo-qadam/package.json"
commit_all "$dir" 'feat: add a required prop while package.json is corrupted'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "a genuinely unreadable package.json version must be treated as 'cannot tell', not as 'not majored' — mutation: reverting checkMajorBump's resolvable flag makes this FAIL despite there being no way to confirm a bump did NOT happen"

echo "== core qadams are scanned too =="

read -r dir base head <<< "$(build_case reject-core-qadam core 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "core qadam path is scanned, not just community"
expect_contains "packages/qadams/core/demo-qadam" "core qadam path is named in the violation"

echo "== no qadam files touched at all is an ordinary pass, not a loud failure =="

dir="$(new_repo no-qadam-changes)"
mkdir -p "${dir}/packages/web/src"
printf 'export const x = 1;\n' > "${dir}/packages/web/src/x.ts"
commit_all "$dir" 'feat: baseline'
base="$(git -C "$dir" rev-parse HEAD)"
printf 'export const x = 2;\n' > "${dir}/packages/web/src/x.ts"
commit_all "$dir" 'fix: unrelated web change'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "zero modified qadam files is the ordinary case, unlike check-dropdown-defaults's full-tree guard"
expect_contains "no modified qadam action/trigger files" "the ordinary-case message is the one actually emitted"

echo "== an unreachable range fails loudly, and git's own stderr is not duplicated =="

dir="$(new_repo unreachable-range)"
write_qadam "$dir" community demo-qadam 0.1.0 "    mode: Property.ShortText({ displayName: 'Mode', required: false }),"
commit_all "$dir" 'feat: baseline'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" 'not-a-real-sha' "$head"
expect_status 1 "an unresolvable base SHA must fail, not report a clean diff"
expect_contains "could not diff" "the reason is named"
occurrences="$(count_occurrences "$last_out" "ambiguous argument")"
if [ "$occurrences" -eq 1 ]; then
  ok
else
  fail_case "git's raw stderr must appear exactly once (surfaced deliberately in our own message), not a second time via inherited stdio" \
    "expected 1 occurrence of 'ambiguous argument', got ${occurrences}"
fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
