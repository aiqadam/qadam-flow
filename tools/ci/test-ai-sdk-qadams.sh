#!/usr/bin/env bash
#
# Fixture tests for tools/ci/ai-sdk-qadams.mjs (#1027), the lister behind the "Build the qadams
# that depend on the AI SDK" step. Its one safety property is that it never prints an empty list:
# a build step with no filters would pass while checking nothing.
#
#   tools/ci/test-ai-sdk-qadams.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lister="${here}/ai-sdk-qadams.mjs"

pass=0
fail=0
root=""

cleanup() {
  [ -n "$root" ] && rm -rf "$root"
  return 0
}
trap cleanup EXIT

new_root() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "${root}/packages/qadams"
}

# write_manifest <relative dir> <json>
write_manifest() {
  mkdir -p "${root}/packages/qadams/$1"
  printf '%s\n' "$2" > "${root}/packages/qadams/$1/package.json"
}

# expect <name> <expected exit> <expected stdout>
expect() {
  local out code
  out="$(node "$lister" --root "$root" 2>/dev/null)"
  code=$?
  if [ "$code" = "$2" ] && [ "$out" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s: exit %s, stdout [%s] (expected exit %s, stdout [%s])\n' "$1" "$code" "$out" "$2" "$3"
  fi
}

new_root
write_manifest framework '{"name":"@aiqadam/qadams-framework","dependencies":{"zod":"4.3.6"}}'
write_manifest community/slack '{"name":"@aiqadam/qadam-slack","dependencies":{"@aiqadam/qadams-framework":"0.1.0"}}'
expect 'no qadam depends on the SDK fails instead of building nothing' 1 ''

new_root
write_manifest framework '{"name":"@aiqadam/qadams-framework"}'
write_manifest community/ai '{"name":"@aiqadam/qadam-ai","dependencies":{"ai":"7.0.163"}}'
write_manifest community/slack '{"name":"@aiqadam/qadam-slack"}'
expect 'only the qadam that depends on ai is listed' 0 '--filter=@aiqadam/qadam-ai'

new_root
write_manifest community/b '{"name":"@aiqadam/qadam-b","devDependencies":{"@ai-sdk/openai":"4.0.109"}}'
write_manifest community/a '{"name":"@aiqadam/qadam-a","dependencies":{"@openrouter/ai-sdk-provider":"3.1.0"}}'
write_manifest community/c '{"name":"@aiqadam/qadam-c","peerDependencies":{"ai-gateway-provider":"4.0.2"}}'
write_manifest community/c/node_modules/x '{"name":"x","dependencies":{"ai":"7.0.163"}}'
expect 'every SDK package and section counts, node_modules is skipped, output is sorted' 0 '--filter=@aiqadam/qadam-a --filter=@aiqadam/qadam-b --filter=@aiqadam/qadam-c'

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
