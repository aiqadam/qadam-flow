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

write_qadam() {
  # $1 = dir, $2 = root (community|core), $3 = qadam name, $4 = version, $5 = props block
  local dir="$1" root="$2" name="$3" version="$4" props="$5"
  local qadam_dir="${dir}/packages/qadams/${root}/${name}"
  mkdir -p "${qadam_dir}/src/lib/actions"
  cat > "${qadam_dir}/package.json" <<EOF
{
  "name": "@aiqadam/qadam-${name}",
  "version": "${version}"
}
EOF
  cat > "${qadam_dir}/src/lib/actions/demo.ts" <<EOF
import { createAction, Property } from '@aiqadam/qadams-framework';

export const demoAction = createAction({
  name: 'demo_action',
  displayName: 'Demo Action',
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

# build_case <name> <root> <base-version> <base-props> <head-version> <head-props>
# Returns "dir base_sha head_sha" on stdout.
build_case() {
  local name="$1" root="$2" base_version="$3" base_props="$4" head_version="$5" head_props="$6"
  local dir
  dir="$(new_repo "$name")"
  write_qadam "$dir" "$root" demo-qadam "$base_version" "$base_props"
  commit_all "$dir" 'feat: baseline'
  local base_sha head_sha
  base_sha="$(git -C "$dir" rev-parse HEAD)"
  write_qadam "$dir" "$root" demo-qadam "$head_version" "$head_props"
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
expect_contains "0.1.0 -> 0.1.1" "violation names the version pair"
expect_not_contains "'mode'" "the untouched, still-optional 'mode' prop is not itself flagged"

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

echo "== a required prop that carries a defaultValue is fine =="

read -r dir base head <<< "$(build_case accept-has-default community 0.1.0 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false })," \
0.1.1 \
"    mode: Property.ShortText({ displayName: 'Mode', required: false }),
    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: 'queue' }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "new required prop WITH a defaultValue -> PASS"

echo "== a defaultValue removed from an already-required prop is caught =="

read -r dir base head <<< "$(build_case reject-default-removed community 0.1.0 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true, defaultValue: 'queue' })," \
0.1.1 \
"    execution_mode: Property.ShortText({ displayName: 'Execution Mode', required: true }),")"
run_check "$dir" "$base" "$head"
expect_status 1 "defaultValue dropped from an already-required prop, no major bump -> FAIL"

echo "== a prop assigned from a helper call is unresolvable, so it is skipped =="

read -r dir base head <<< "$(build_case skip-helper-call community 0.1.0 \
"    chat_id: telegramCommons.chatIdProp()," \
0.1.1 \
"    chat_id: telegramCommons.chatIdProp({ stricter: true }),")"
run_check "$dir" "$base" "$head"
expect_status 0 "a non-literal Property.X(...) call can't be verified, so nothing is asserted"

echo "== a brand-new action file (not a modification) is out of scope =="

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
commit_all "$dir" 'feat: add a second action'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" "$base" "$head"
expect_status 0 "a required-no-default prop in a brand-new (Added) file is not this check's concern"

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
expect_not_contains "scanned 0 files under" "this checker must not borrow the other script's empty-scan-is-fatal wording"

echo "== an unreachable range fails loudly instead of reading as \"nothing changed\" =="

dir="$(new_repo unreachable-range)"
write_qadam "$dir" community demo-qadam 0.1.0 "    mode: Property.ShortText({ displayName: 'Mode', required: false }),"
commit_all "$dir" 'feat: baseline'
head="$(git -C "$dir" rev-parse HEAD)"
run_check "$dir" 'not-a-real-sha' "$head"
expect_status 1 "an unresolvable base SHA must fail, not report a clean diff"
expect_contains "could not diff" "the reason is named"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
