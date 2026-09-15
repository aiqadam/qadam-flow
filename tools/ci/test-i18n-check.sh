#!/usr/bin/env bash
#
# Fixture tests for the i18n parity checker (#416).
#
# The checker is the only thing standing between the hand-maintained locales and
# the silent en-only drift that #416 documented, so its failure modes are tested
# explicitly: every invariant gets a fixture that must fail, and the fixer is
# verified to prune without disturbing the rest of the file (including the two
# different trailing-newline conventions in the web and qadam catalogs).
#
# Run from the `Lint + Unit Tests` job (it only needs node + the workspace deps).
#
#   tools/ci/test-i18n-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-i18n.mjs"

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
  mkdir -p "$root/packages/shared/src/lib/core/common"
  mkdir -p "$root/tools/ci"
  cat > "$root/packages/shared/src/lib/core/common/locale.ts" <<'EOF'
export enum LocalesEnum {
    ENGLISH = 'en',
    RUSSIAN = 'ru',
    UZBEK = 'uz',
    KAZAKH = 'kk',
}
EOF
  for locale in en ru uz kk; do
    mkdir -p "$root/packages/web/public/locales/${locale}"
  done
  printf '{"entries":[]}\n' > "$root/tools/ci/i18n-allowlist.json"
}

write_json() {
  printf '%s\n' "$2" > "$1"
}

run_check() {
  out="$(node "$checker" --root "$root" "$@" 2>&1)"
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

base_catalogs() {
  write_json "$root/packages/web/public/locales/en/translation.json" '{"greeting": "Hello", "runs": "{count, plural, =1 {1 run} other {# runs}}"}'
  write_json "$root/packages/web/public/locales/ru/translation.json" '{"greeting": "Привет", "runs": "{count, plural, =0 {0 запусков} =1 {1 запуск} one {# запуск} few {# запуска} many {# запусков} other {# запуска}}"}'
  write_json "$root/packages/web/public/locales/kk/translation.json" '{"greeting": "Сәлем", "runs": "{count, plural, =1 {1 орындалу} other {# орындалу}}"}'
  write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "{count, plural, =1 {1 ijro} other {# ijro}}"}'
}

echo "== a consistent tree passes =="

new_root
base_catalogs
run_check
expect_status 0 "consistent web catalogs"
expect_contains "i18n check passed" "consistent web catalogs"

echo "== web: every invariant fails loudly =="

new_root
base_catalogs
write_json "$root/packages/web/public/locales/ru/translation.json" '{"greeting": "Привет"}'
run_check
expect_status 1 "missing key in ru"
expect_contains "missing-key: 1" "missing key in ru"

new_root
base_catalogs
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "{count, plural, =1 {1 ijro} other {# ijro}}", "stale": "eski"}'
run_check
expect_status 1 "stale key in uz"
expect_contains "stale-key: 1" "stale key in uz"
run_check --fix
expect_status 0 "stale key in uz is pruned by --fix"
expect_contains "fix:" "--fix reports the pruned file"
node -e "const j=require('$root/packages/web/public/locales/uz/translation.json'); if ('stale' in j) process.exit(1)" || bad "--fix must remove the stale key"
grep -q 'stale' "$root/packages/web/public/locales/uz/translation.json" && bad "--fix must remove the stale key's line" || ok

new_root
base_catalogs
write_json "$root/packages/web/public/locales/kk/translation.json" '{"greeting": "", "runs": "{count, plural, =1 {1 орындалу} other {# орындалу}}"}'
run_check
expect_status 1 "empty value in kk"
expect_contains "empty-value: 1" "empty value in kk"

new_root
base_catalogs
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Hello", "runs": "{count, plural, =1 {1 ijro} other {# ijro}}"}'
run_check
expect_status 1 "value identical to en in uz"
expect_contains "untranslated-value: 1" "value identical to en in uz"
write_json "$root/tools/ci/i18n-allowlist.json" '{"entries": [{"key": "greeting", "locales": ["uz"], "reason": "test fixture"}]}'
run_check
expect_status 0 "allowlisted identical value passes"
write_json "$root/tools/ci/i18n-allowlist.json" '{"entries": [{"key": "greeting", "locales": ["kk"], "reason": "wrong locale"}]}'
run_check
expect_status 1 "allowlist entry scoped to another locale does not pass"

new_root
base_catalogs
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "ijro"}'
run_check
expect_status 1 "dropped ICU argument in uz"
expect_contains "icu-arguments: 1" "dropped ICU argument in uz"

new_root
base_catalogs
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "{count, plural, =1 {1 ijro} other {# {extra} ijro}}"}'
run_check
expect_status 1 "unexpected ICU argument in uz"
expect_contains "icu-arguments: 1" "unexpected ICU argument in uz"

new_root
base_catalogs
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "{count, plural, =1 {1 ijro} other {# ijro}"}'
run_check
expect_status 1 "invalid ICU in uz"
expect_contains "not valid ICU" "invalid ICU in uz"

echo "== ru/kk plural branches do not count as a mismatch =="

new_root
base_catalogs
run_check
expect_status 0 "extra plural branches in ru/kk are not an ICU violation"
expect_not_contains "icu-arguments" "set comparison, not multiset"

echo "== the locale list is pinned to LocalesEnum =="

new_root
base_catalogs
rm -rf "$root/packages/web/public/locales/kk"
run_check
expect_status 1 "declared locale has no directory"
expect_contains "locales-enum: 1" "declared locale has no directory"
expect_not_contains "undefined —" "locales-enum violations carry a real file"

new_root
base_catalogs
mkdir -p "$root/packages/web/public/locales/tr"
write_json "$root/packages/web/public/locales/tr/translation.json" '{"greeting": "Merhaba", "runs": "{count, plural, =1 {1 çalıştırma} other {# çalıştırma}}"}'
run_check
expect_status 1 "undeclared locale directory"
expect_contains "locales-enum: 1" "undeclared locale directory"
expect_not_contains "undefined —" "undeclared-directory violations carry a real file"

# A two-letter constant outside the enum is not a locale declaration.
new_root
base_catalogs
cat > "$root/packages/shared/src/lib/core/common/locale.ts" <<'EOF'
export const DEFAULT_COUNTRY = 'us'

export enum LocalesEnum {
    ENGLISH = 'en',
    RUSSIAN = 'ru',
    UZBEK = 'uz',
    KAZAKH = 'kk',
}
EOF
run_check
expect_status 0 "two-letter constant outside LocalesEnum is ignored"

# A declared locale whose catalog file is gone is a violation, not a crash.
new_root
base_catalogs
rm "$root/packages/web/public/locales/uz/translation.json"
run_check
expect_status 1 "declared locale with no catalog file"
expect_contains "missing-file: 1" "declared locale with no catalog file"
expect_not_contains "ENOENT" "missing catalog file does not crash the checker"

# A malformed allowlist entry is a configuration error, not a crash mid-run.
new_root
base_catalogs
write_json "$root/tools/ci/i18n-allowlist.json" '{"entries": [{"key": "greeting"}]}'
run_check
expect_status 1 "malformed allowlist entry"
expect_contains "every entry needs" "malformed allowlist entry names the file"

echo "== qadam catalogs: consistency without coverage =="

new_root
base_catalogs
mkdir -p "$root/packages/qadams/community/demo/src/i18n"
write_json "$root/packages/qadams/community/demo/src/i18n/translation.json" '{"Airtable": "Airtable", "New record": "New record"}'
write_json "$root/packages/qadams/community/demo/src/i18n/ru.json" '{"Airtable": "Airtable"}'
run_check
expect_status 0 "qadam locale is allowed to cover a subset of translation.json"

new_root
base_catalogs
mkdir -p "$root/packages/qadams/community/demo/src/i18n"
write_json "$root/packages/qadams/community/demo/src/i18n/translation.json" '{"Airtable": "Airtable"}'
write_json "$root/packages/qadams/community/demo/src/i18n/ru.json" '{"Airtable": "Airtable", "Gone": "Исчез"}'
cp "$root/packages/qadams/community/demo/src/i18n/ru.json" "$root/before-fix.json"
run_check
expect_status 1 "qadam stale key"
expect_contains "stale-key: 1" "qadam stale key"
run_check --fix
expect_status 1 "qadam stale keys are never pruned by --fix"
expect_contains "never pruned automatically" "qadam guidance explains the manual step"
cmp -s "$root/before-fix.json" "$root/packages/qadams/community/demo/src/i18n/ru.json" && ok || bad "--fix must leave qadam catalogs untouched"

# The qadam catalogs have no trailing newline today; the web catalogs do. The
# fixer must prune web keys without normalising the newline convention, and must
# leave qadam catalogs byte-for-byte untouched.
trailing_root() {
  new_root
  base_catalogs
  mkdir -p "$root/packages/qadams/community/demo/src/i18n"
  write_json "$root/packages/qadams/community/demo/src/i18n/translation.json" '{"Airtable": "Airtable"}'
  printf '{"Airtable": "Airtable", "Gone": "Исчез"}' > "$root/packages/qadams/community/demo/src/i18n/ru.json"
  cp "$root/packages/qadams/community/demo/src/i18n/ru.json" "$root/before-fix.json"
  write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Salom", "runs": "{count, plural, =1 {1 ijro} other {# ijro}}", "stale": "eski"}'
}

trailing_root
run_check --fix
expect_status 1 "fixer prunes only the web catalog, the qadam key still fails"
cmp -s "$root/before-fix.json" "$root/packages/qadams/community/demo/src/i18n/ru.json" && ok || bad "qadam catalog changed under --fix"
if [ "$(tail -c 1 "$root/packages/web/public/locales/uz/translation.json" | wc -l)" -eq 1 ]; then ok; else bad "web file lost its trailing newline"; fi
node -e "const j=require('$root/packages/web/public/locales/uz/translation.json'); if ('stale' in j) process.exit(1)" || bad "web stale key was not pruned"

new_root
base_catalogs
mkdir -p "$root/packages/qadams/community/demo/src/i18n"
write_json "$root/packages/qadams/community/demo/src/i18n/translation.json" '{"Airtable": "Airtable"}'
write_json "$root/packages/qadams/community/demo/src/i18n/ru.json" '{"Airtable": ""}'
run_check
expect_status 1 "empty qadam value"
expect_contains "qadam: 1 violation" "empty qadam value is reported under the qadam scope"

new_root
base_catalogs
mkdir -p "$root/packages/qadams/community/demo/src/i18n"
write_json "$root/packages/qadams/community/demo/src/i18n/ru.json" '{"Airtable": "Airtable"}'
run_check
expect_status 1 "qadam locale without a source"
expect_contains "missing-source: 1" "qadam locale without a source"

echo "== --init-allowlist =="

new_root
write_json "$root/packages/web/public/locales/en/translation.json" '{"greeting": "Hello", "footer": "Build"}'
write_json "$root/packages/web/public/locales/ru/translation.json" '{"greeting": "Hello", "footer": "Build"}'
write_json "$root/packages/web/public/locales/kk/translation.json" '{"greeting": "Hello", "footer": "Build"}'
write_json "$root/packages/web/public/locales/uz/translation.json" '{"greeting": "Hello", "footer": "Build"}'
run_check --init-allowlist
expect_status 0 "--init-allowlist always succeeds"
node -e "const a=require('$root/tools/ci/i18n-allowlist.json'); if (a.entries.length !== 2) process.exit(1)" || bad "--init-allowlist must record both identical keys"
run_check
expect_status 0 "a check against the generated allowlist passes"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "i18n checker tests FAILED — the translation gate is not trustworthy until this is green."
  exit 1
fi
echo "i18n checker tests passed."
