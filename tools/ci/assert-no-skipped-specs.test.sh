#!/usr/bin/env bash
#
# Tests for tools/ci/assert-no-skipped-specs.mjs (#342, extended for #337).
#
#   tools/ci/assert-no-skipped-specs.test.sh
#
# The gate that stops a skipped mail spec (#342) or chat spec (#337) from passing its `e2e` job
# phase unnoticed: Playwright exits 0 whether a test ran or was test.skip()-ed, so this script's
# own correctness is what the acceptance criterion actually rests on. Pure Node against synthetic
# fixtures — no Postgres/Redis/Playwright needed — so it runs with the other tools/ci suites before
# any install.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/assert-no-skipped-specs.mjs"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

spec() {
  local title="$1" status="$2"
  printf '{"title":%s,"tests":[{"status":%s}]}' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$title")" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$status")"
}

write_report() {
  local path="$1"
  shift
  local specs_json
  specs_json="$(IFS=,; echo "$*")"
  printf '{"suites":[{"specs":[%s]}]}' "$specs_json" > "$path"
}

expect_status() {
  local want="$1" desc="$2"
  shift 2
  local got=0
  node "$script" "$@" >/dev/null 2>&1 || got=$?
  if [ "$got" -eq "$want" ]; then
    ok
  else
    bad "${desc}: expected exit ${want}, got ${got}"
  fi
}

echo "== a clean report with every required title present passes =="

report="${tmp}/all-passed.json"
write_report "$report" \
  "$(spec 'arrives as a real email' expected)" \
  "$(spec 'sends a real email' expected)" \
  "$(spec 'an unrelated passing spec' expected)"

expect_status 0 'all specs expected, both required titles present' \
  "$report" 'arrives as a real email' 'sends a real email'

echo "== any skipped spec fails the job, even one unrelated to the required titles =="

report="${tmp}/one-skipped.json"
write_report "$report" \
  "$(spec 'arrives as a real email' expected)" \
  "$(spec 'sends a real email' expected)" \
  "$(spec 'an unrelated spec' skipped)"

expect_status 1 'one unrelated spec skipped' "$report"

echo "== a required title that never ran fails, even with zero skips =="

report="${tmp}/missing-title.json"
write_report "$report" \
  "$(spec 'sends a real email' expected)"

expect_status 1 'required title never ran' \
  "$report" 'arrives as a real email' 'sends a real email'

echo "== a skip matching --ignore-skip does not fail the job =="

report="${tmp}/one-expected-skip.json"
write_report "$report" \
  "$(spec 'reaches the AI provider row the operator configured (#174)' expected)" \
  "$(spec 'streams a real answer from the provider the operator configured (#174)' skipped)"

expect_status 0 'ignored skip alone' \
  "$report" --ignore-skip 'streams a real answer from the provider the operator configured' \
  'reaches the AI provider row the operator configured (#174)'

echo "== --ignore-skip only exempts the matching title, not other skips =="

report="${tmp}/ignored-plus-unrelated-skip.json"
write_report "$report" \
  "$(spec 'streams a real answer from the provider the operator configured (#174)' skipped)" \
  "$(spec 'an unrelated spec' skipped)"

expect_status 1 'other skip still fails when --ignore-skip matches a different spec' \
  "$report" --ignore-skip 'streams a real answer from the provider the operator configured'

echo "== a trailing --ignore-skip with no value fails rather than silently matching 'undefined' =="

report="${tmp}/trailing-ignore-skip.json"
write_report "$report" \
  "$(spec 'an unrelated spec' expected)"

expect_status 1 'trailing --ignore-skip with no value' "$report" --ignore-skip

echo "== a report with zero specs fails rather than reading as an empty pass =="

report="${tmp}/empty.json"
printf '{"suites":[]}' > "$report"

expect_status 1 'zero specs in the report' "$report"

echo "== a missing report path fails rather than throwing a stack trace as a pass =="

expect_status 1 'nonexistent report file' "${tmp}/does-not-exist.json"

echo "== no report path argument at all fails =="

expect_status 1 'no arguments'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
