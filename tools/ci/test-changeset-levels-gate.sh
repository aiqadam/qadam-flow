#!/usr/bin/env bash
#
# Fixture tests for tools/ci/check-changeset-levels.mjs — ADR-0001 gate 2 (the declared changeset
# level is not below the level computed from the qadam's actions / triggers / props surface), and
# the `semver-override` verdict it reads.
#
# Real throwaway git repositories; every reject case has an accept case that differs only in the
# declared level, so a gate that computed nothing (and therefore demanded nothing) fails here.
# Needs `typescript` from node_modules, so it runs after install in _verify.yml.
#
#   tools/ci/test-changeset-levels-gate.sh

set -uo pipefail

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'
unset GITHUB_HEAD_REF GITHUB_BASE_REF PR_BASE_SHA PR_HEAD_SHA SEMVER_OVERRIDE

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="${here}/check-changeset-levels.mjs"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CEILING_DIRECTORIES="$tmp"

pass=0
fail=0
last_out=''

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do printf '        %s\n' "$line"; done
  printf '        --- gate output ---\n'
  printf '%s\n' "$last_out" | sed 's/^/        | /'
}

ok() { pass=$((pass + 1)); }

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

Q='packages/qadams/core/demo'

# The action file the cases mutate. `$1` is the props block body.
action() {
  printf "import { createAction, Property } from '@aiqadam/qadams-framework'\n\nexport const send = createAction({\n  name: 'send_message',\n  displayName: 'Send',\n  props: {\n%s\n  },\n  async run() { return 1 },\n})\n" "$1"
}

BASE_PROPS="    text: Property.ShortText({ displayName: 'Text', required: true }),
    mode: Property.StaticDropdown({ displayName: 'Mode', required: false, options: { options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] } }),
    note: Property.LongText({ displayName: 'Note', required: false }),
    chat: helpers.chatProp({ required: false }),"

# new_repo <name> <qadam-version>
new_repo() {
  local dir="${tmp}/$1" version="${2:-0.4.0}"
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config commit.gpgsign false
  write "$dir/package.json" '{ "name": "qadam-flow", "version": "2.0.0", "private": true, "workspaces": ["packages/platform", "packages/qadams/framework", "packages/qadams/core/*"] }'
  write "$dir/packages/platform/package.json" '{ "name": "@aiqadam/platform", "version": "2.0.0", "private": true }'
  write "$dir/packages/qadams/framework/package.json" '{ "name": "@aiqadam/qadams-framework", "version": "0.35.0" }'
  write "$dir/packages/qadams/framework/src/index.ts" 'export const x = 1'
  write "$dir/$Q/package.json" "{ \"name\": \"@aiqadam/qadam-demo\", \"version\": \"${version}\" }"
  write "$dir/$Q/src/index.ts" "export const demo = createQadam({ actions: [send, other], triggers: [newItem] })"
  write "$dir/$Q/src/lib/send.ts" "$(action "$BASE_PROPS")"
  write "$dir/$Q/src/lib/other.ts" "export const other = createAction({ name: 'other', props: { id: Property.Number({ displayName: 'Id', required: true }) }, async run() { return 1 } })"
  write "$dir/$Q/src/lib/trigger.ts" "export const newItem = createTrigger({ name: 'new_item', props: {}, async run() { return [] } })"
  write "$dir/.changeset/config.json" '{ "privatePackages": { "version": true, "tag": false }, "ignore": [] }'
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
  git -C "$dir" tag base
  printf '%s\n' "$dir"
}

# change <dir> <level|-> — commits the working tree plus (unless `-`) a changeset for the qadam.
change() {
  local dir="$1" level="$2"
  if [ "$level" != '-' ]; then
    write "$dir/.changeset/demo.md" "$(printf -- '---\n"@aiqadam/qadam-demo": %s\n---\n\nChange.' "$level")"
  fi
  git -C "$dir" add -A && git -C "$dir" commit -q -m change
}

expect() {
  local want="$1" label="$2" dir="$3" needle="$4" got
  shift 4
  last_out="$(cd "$dir" && env PR_BASE_SHA=base PR_HEAD_SHA=HEAD "$@" timeout 60 node "$gate" 2>&1)"
  got=$?
  if [ "$got" -ne "$want" ]; then
    fail_case "$label" "want exit ${want}, got ${got}"
    return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$last_out" | grep -qF -- "$needle"; then
    fail_case "$label" "exit ${got} was right, but output does not mention: ${needle}"
    return
  fi
  ok
}

# pair <label> <qadam-version> <too-low> <enough> <needle> <mutation...>
# Builds the same change twice: once declared one level too low (must fail), once at the computed
# level (must pass). The mutation is a shell snippet run with $d set to the repo.
pair() {
  local label="$1" version="$2" low="$3" enough="$4" needle="$5" mutation="$6" d
  d="$(new_repo "low-${label// /-}" "$version")"; eval "$mutation"; change "$d" "$low"
  expect 1 "${label}: declared ${low} -> FAIL" "$d" "$needle"
  d="$(new_repo "ok-${label// /-}" "$version")"; eval "$mutation"; change "$d" "$enough"
  expect 0 "${label}: declared ${enough} -> PASS" "$d" ''
}

echo "== BREAKING (0.x: minor is the breaking slot; 1.x: major) =="

pair 'action removed on 0.x' 0.4.0 patch minor "action 'other' removed" \
  'rm "$d/$Q/src/lib/other.ts"'
pair 'action removed on 1.x' 1.2.0 minor major "action 'other' removed" \
  'rm "$d/$Q/src/lib/other.ts"'
pair 'trigger removed' 1.2.0 minor major "trigger 'new_item' removed" \
  'rm "$d/$Q/src/lib/trigger.ts"'
pair 'prop removed' 1.2.0 minor major 'send_message.note removed' \
  'write "$d/$Q/src/lib/send.ts" "$(action "$(printf "%s\n" "$BASE_PROPS" | grep -v note)")"'
pair 'prop factory changed' 1.2.0 minor major 'send_message.note changed Property.LongText -> Property.Number' \
  'write "$d/$Q/src/lib/send.ts" "$(action "${BASE_PROPS/Property.LongText/Property.Number}")"'
pair 'optional prop became required with no default' 1.2.0 minor major 'send_message.note became required with no default' \
  'write "$d/$Q/src/lib/send.ts" "$(action "${BASE_PROPS/"Note'"'"', required: false"/"Note'"'"', required: true"}")"'
pair 'new required prop with no default' 1.2.0 minor major 'send_message.extra added as required with no default' \
  'write "$d/$Q/src/lib/send.ts" "$(action "$BASE_PROPS
    extra: Property.ShortText({ displayName: '"'"'X'"'"', required: true }),")"'
pair 'dropdown value removed' 1.2.0 minor major "send_message.mode dropdown value(s) removed: \"b\"" \
  'sed -i "s/, { label: .B., value: .b. }//" "$d/$Q/src/lib/send.ts"'

echo "== FEATURE (0.x: patch; 1.x: minor) =="

pair 'new action on 1.x' 1.2.0 patch minor "action 'third' added" \
  'write "$d/$Q/src/lib/third.ts" "export const third = createAction({ name: '"'"'third'"'"', props: {}, async run() { return 1 } })"'
pair 'new optional prop on 1.x' 1.2.0 patch minor 'send_message.extra added' \
  'write "$d/$Q/src/lib/send.ts" "$(action "$BASE_PROPS
    extra: Property.ShortText({ displayName: '"'"'X'"'"', required: false }),")"'

d="$(new_repo feature-0x 0.4.0)"
write "$d/$Q/src/lib/third.ts" "export const third = createAction({ name: 'third', props: {}, async run() { return 1 } })"
change "$d" patch
expect 0 'a new action on 0.x needs only a patch' "$d" "computed patch"

echo "== NOT A BREAK (must not over-demand) =="

d="$(new_repo fix-only 1.2.0)"
write "$d/$Q/src/lib/send.ts" "$(action "$BASE_PROPS")
// a fix"
change "$d" patch
expect 0 'a src change with an unchanged surface needs only a patch' "$d" 'computed patch'

d="$(new_repo required-with-default 1.2.0)"
write "$d/$Q/src/lib/send.ts" "$(action "${BASE_PROPS/"Note', required: false"/"Note', required: true, defaultValue: 'x'"}")"
change "$d" patch
expect 0 'an optional prop made required WITH a default is not a break' "$d" 'computed patch'

d="$(new_repo dropdown-value-added 1.2.0)"
sed -i "s/{ label: .B., value: .b. }/&, { label: 'C', value: 'c' }/" "$d/$Q/src/lib/send.ts"
grep -qF "value: 'c'" "$d/$Q/src/lib/send.ts" || fail_case 'fixture: the dropdown-add mutation did not apply'
change "$d" patch
expect 0 'a dropdown value added is not a break' "$d" 'computed patch'

d="$(new_repo action-moved 1.2.0)"
git -C "$d" mv "$Q/src/lib/other.ts" "$Q/src/lib/moved-other.ts"
printf '// moved\n' >> "$d/$Q/src/lib/moved-other.ts"
change "$d" patch
expect 0 'an action moved to another file is the same action' "$d" 'computed patch'

d="$(new_repo helper-prop 1.2.0)"
write "$d/$Q/src/lib/send.ts" "$(action "${BASE_PROPS/"helpers.chatProp({ required: false })"/"helpers.chatProp({ required: true })"}")"
change "$d" patch
expect 0 'a prop built by a helper is unresolvable and never guessed at' "$d" 'computed patch'

d="$(new_repo props-spread 1.2.0)"
write "$d/$Q/src/lib/send.ts" "$(action "    ...commonProps,
$(printf "%s\n" "$BASE_PROPS" | grep -v note)")"
change "$d" patch
expect 0 'a props-level spread makes removals untrustworthy, so none is reported' "$d" 'computed patch'

d="$(new_repo sdk 1.2.0)"
write "$d/packages/qadams/framework/src/index.ts" 'export const y = 2'
write "$d/.changeset/sdk.md" $'---\n"@aiqadam/qadams-framework": patch\n---\n\nSDK.'
git -C "$d" add -A && git -C "$d" commit -q -m sdk
expect 0 'the SDK half is not computed yet and says so' "$d" 'not computed: the SDK public .d.ts diff is not implemented yet'

echo "== OVERRIDE =="

d="$(new_repo override-granted 1.2.0)"
rm "$d/$Q/src/lib/other.ts"; change "$d" patch
expect 0 'a maintainer-applied semver-override passes, and says who' "$d" 'OVERRIDDEN by the semver-override label, applied by @binalirustamov' SEMVER_OVERRIDE=granted:binalirustamov
expect 1 'a semver-override not applied by a maintainer fails, with the reason' "$d" 'applied by @someone, who is write, not admin or maintain' 'SEMVER_OVERRIDE=denied:applied by @someone, who is write, not admin or maintain'
expect 1 'no label -> FAIL' "$d" "declares 'patch' but the change needs at least 'major'" SEMVER_OVERRIDE=absent
expect 1 'a malformed verdict is not a grant' "$d" 'does not count' 'SEMVER_OVERRIDE=granted:bad user'

echo "== UNKNOWN =="

d="$(new_repo bad-base 1.2.0)"
change "$d" patch
expect 2 'an unreachable base SHA -> UNKNOWN' "$d" 'UNKNOWN' PR_BASE_SHA=0000000000000000000000000000000000000000

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
