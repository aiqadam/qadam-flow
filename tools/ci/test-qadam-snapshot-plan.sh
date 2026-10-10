#!/usr/bin/env bash
#
# Fixture tests for the versions a build gives the official qadams (ADR-0004, #851):
#   - tools/ci/changeset-plan.mjs — each package's OWN pending level, apart from dependent bumps;
#     "unavailable" (never a guess) for pre mode and for a changeset it cannot read;
#   - tools/scripts/qadams/snapshot/snapshot-plan.mjs through compute-snapshot-plan.mjs — the
#     `<next>-main.<n>` snapshot of a changed qadam, the released number of an unchanged one, and
#     both fallbacks of a build from `main` (no release archive, no release plan), each with a
#     warning; the release build that fails instead;
#   - tools/scripts/qadams/snapshot/release-archive.mjs — the archive an unchanged bundle-format
#     qadam comes from, today never configured (the "available" branch is exercised on a fixture);
#   - every version the tool produces against the one parser in `@aiqadam/shared`, which a plain-node
#     script cannot import (needs `bun`, as the rest of `verify` does).
#
# Same construction as test-main-version.sh: throwaway trees, accept and reject cases.
#
#   tools/ci/test-qadam-snapshot-plan.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cli="$repo_root/tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs"
parser="$repo_root/packages/shared/src/lib/automation/qadams/qadam-version.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$3" "$2"; fi
}

write() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# new_tree <name> — a tree with no qadams and no changesets; add_qadam / changeset fill it.
new_tree() {
  local dir="$tmp/$1"
  mkdir -p "$dir/packages/qadams/core" "$dir/packages/qadams/community"
  write "$dir/package.json" '{ "name": "qadam-flow", "version": "1.1.0", "private": true }'
  write "$dir/.changeset/config.json" '{ "baseBranch": "main", "privatePackages": { "version": true, "tag": false }, "ignore": [] }'
  write "$dir/.changeset/README.md" '# Changesets'
  printf '%s\n' "$dir"
}

# add_qadam <tree> <core|community> <directory name> <version>
add_qadam() {
  write "$1/packages/qadams/$2/$3/package.json" "{ \"name\": \"@aiqadam/qadam-$3\", \"version\": \"$4\" }"
}

changeset() { write "$1/.changeset/$2.md" "$3"; }

# add_archive <dir> <name> <version> — an archive as `--pack` writes it, with one tarball.
add_archive() {
  local dir="$1" file="aiqadam-qadam-$2-$3.tgz"
  mkdir -p "$dir"
  printf 'tarball' > "$dir/$file"
  local entry="{ \"name\": \"@aiqadam/qadam-$2\", \"version\": \"$3\", \"kind\": \"bundle\", \"file\": \"$file\", \"integrity\": \"sha512-x\", \"commit\": { \"sha\": \"abc\", \"dirtyQadams\": false } }"
  if [ -f "$dir/archive-index.json" ]; then
    node -e "const fs=require('fs');const f=process.argv[1];const i=JSON.parse(fs.readFileSync(f));i.artifacts.push(JSON.parse(process.argv[2]));fs.writeFileSync(f,JSON.stringify(i))" "$dir/archive-index.json" "$entry"
  else
    printf '{ "formatVersion": 1, "artifacts": [ %s ] }\n' "$entry" > "$dir/archive-index.json"
  fi
}

rc=0
err=''
plan_file="$tmp/plan.json"
# run_plan <args…> — stdout is discarded, the plan goes to $plan_file, stderr is kept.
run_plan() {
  rm -f "$plan_file"
  err="$(node "$cli" --out "$plan_file" "$@" 2>&1 >/dev/null)"
  rc=$?
}

# entry <name> <field> — a field of one package in the last plan.
entry() {
  node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1]));const e=p.packages.find(e=>e.name==='@aiqadam/qadam-'+process.argv[2]);console.log(e===undefined?'(absent)':e[process.argv[3]])" "$plan_file" "$1" "$2"
}

plan_field() {
  node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1]));console.log($1)" "$plan_file"
}

echo "== a build from main, plan and archive known =="

d="$(new_tree known)"
add_qadam "$d" core slack 0.4.15
add_qadam "$d" core tables 0.5.0
add_qadam "$d" community discord 0.2.3
add_qadam "$d" community notion 1.3.4
add_qadam "$d" community trello 1.1.0
add_qadam "$d" community dependent 0.9.0
changeset "$d" a $'---\n"@aiqadam/qadam-slack": patch\n"@aiqadam/qadam-tables": minor\n---\n\nChanged.'
changeset "$d" b $'---\n"@aiqadam/qadam-discord": major\n"@aiqadam/qadam-trello": minor\n"@aiqadam/qadam-slack": minor\n---\n\nChanged again.'
changeset "$d" c $'---\n"@aiqadam/qadams-framework": minor\n"@aiqadam/qadam-notion": none\n---\n\nFramework change; a dependent bump is not an own changeset.'
add_archive "$tmp/archive-known" notion 1.3.4
run_plan --root "$d" --counter 412 --archive "$tmp/archive-known" --platform-version 1.2.0-main.412
check 'exit 0' "$rc" '0'
check 'no warning when nothing falls back' "$(plan_field 'p.warnings.length')" '0'
check 'own patch changeset: next patch snapshot' "$(entry slack version)" '0.5.0-main.412'
check 'the highest own level across changesets wins (patch + minor)' "$(entry slack level)" 'minor'
check 'own minor changeset on 0.x' "$(entry tables version)" '0.6.0-main.412'
check 'own major changeset on 0.x is what the author declared' "$(entry discord version)" '1.0.0-main.412'
check 'own minor changeset on 1.x' "$(entry trello version)" '1.2.0-main.412'
check 'a snapshot is built from the tree' "$(entry slack origin)" 'tree'
check '0.x without a changeset keeps its released number, from the tree' "$(entry dependent version) $(entry dependent origin) $(entry dependent reason)" '0.9.0 tree legacy-from-tree'
check 'a changeset on the framework gives no qadam a snapshot' "$(entry dependent version)" '0.9.0'
check 'level none is not a changeset: the unchanged bundle comes from the archive' "$(entry notion version) $(entry notion origin) $(entry notion reason)" '1.3.4 archive released-from-archive'
check 'the platform version is recorded' "$(plan_field 'p.platformVersion')" '1.2.0-main.412'
check 'the counter is recorded' "$(plan_field 'p.counter')" '412'

echo "== a build from main, no release archive =="

run_plan --root "$d" --counter 412
check 'exit 0: a main build does not fail without the archive' "$rc" '0'
check 'own changesets keep the plan'"'"'s <next>' "$(entry tables version)" '0.6.0-main.412'
check 'a bundle-format qadam without a changeset is built as a next-patch snapshot' "$(entry notion version) $(entry notion origin) $(entry notion reason)" '1.3.5-main.412 tree no-archive'
check '0.x qadams do not depend on the archive' "$(entry dependent version)" '0.9.0'
check 'the archive is reported unavailable' "$(plan_field 'p.archive.available')" 'false'
check 'one warning, naming the qadam' "$(plan_field 'p.warnings.length') $(plan_field 'p.warnings[0].includes("qadam-notion")')" '1 true'
check 'the warning is logged' "$(printf '%s' "$err" | grep -c 'WARNING — the release archive is unavailable')" '1'

echo "== a build from main, an archive that lacks the released artifact =="

add_archive "$tmp/archive-other" discord 0.2.3
run_plan --root "$d" --counter 412 --archive "$tmp/archive-other"
check 'an archive without this version falls back too' "$(entry notion version) $(entry notion reason)" '1.3.5-main.412 not-in-archive'
check 'the archive is available' "$(plan_field 'p.archive.available')" 'true'
check 'the warning says the archive lacks it' "$(plan_field 'p.warnings[0].includes("lacks")')" 'true'

rm "$tmp/archive-known/aiqadam-qadam-notion-1.3.4.tgz"
run_plan --root "$d" --counter 412 --archive "$tmp/archive-known"
check 'an index entry whose tarball is gone is not an archived release' "$(entry notion reason)" 'not-in-archive'

write "$tmp/archive-broken/archive-index.json" '{ "formatVersion": 2, "artifacts": [] }'
run_plan --root "$d" --counter 412 --archive "$tmp/archive-broken"
check 'an unreadable archive index is an unavailable archive' "$(plan_field 'p.archive.available') $(entry notion reason)" 'false no-archive'

echo "== a build from main, no release plan =="

d2="$(new_tree noplan)"
add_qadam "$d2" core slack 0.4.15
add_qadam "$d2" community notion 1.3.4
changeset "$d2" a $'---\n"@aiqadam/qadam-slack": minor\n---\n\nChanged.'
write "$d2/.changeset/pre.json" '{ "mode": "pre", "tag": "rc" }'
add_archive "$tmp/archive-noplan" notion 1.3.4
run_plan --root "$d2" --counter 9 --archive "$tmp/archive-noplan"
check 'exit 0: a main build does not fail without the plan' "$rc" '0'
check 'every qadam is a next-patch snapshot, 0.x included, whatever the archive holds' "$(entry slack version) $(entry slack reason) $(entry notion version) $(entry notion origin)" '0.4.16-main.9 no-plan 1.3.5-main.9 tree'
check 'the plan is reported unavailable' "$(plan_field 'p.changes.available')" 'false'
check 'one warning' "$(plan_field 'p.warnings.length')" '1'
check 'the warning is logged' "$(printf '%s' "$err" | grep -c 'WARNING — the changesets release plan is unavailable')" '1'

d3="$(new_tree badchangeset)"
add_qadam "$d3" core slack 0.4.15
changeset "$d3" a $'---\n"@aiqadam/qadam-slack": huge\n---\n\nChanged.'
run_plan --root "$d3" --counter 9
check 'a changeset it cannot read makes the plan unavailable, not partial' "$(entry slack version) $(entry slack reason)" '0.4.16-main.9 no-plan'

d4="$(new_tree noconfig)"
add_qadam "$d4" core slack 0.4.15
rm "$d4/.changeset/config.json"
run_plan --root "$d4" --counter 9
check 'a missing changesets config makes the plan unavailable' "$(entry slack reason)" 'no-plan'

echo "== a release build fails instead of falling back =="

d5="$(new_tree release)"
add_qadam "$d5" core slack 0.4.15
add_qadam "$d5" community notion 1.3.4
add_archive "$tmp/archive-release" notion 1.3.4
run_plan --root "$d5" --mode release --archive "$tmp/archive-release"
check 'exit 0 with plan and archive' "$rc" '0'
check 'versions stay the released ones: no snapshot in a release' "$(entry slack version) $(entry notion version)" '0.4.15 1.3.4'
check 'an archived release comes from the archive, the rest from the tree' "$(entry notion origin) $(entry slack origin)" 'archive tree'
check 'a release records no counter' "$(plan_field 'p.counter')" 'null'
run_plan --root "$d5" --mode release
check 'no archive: exit 1' "$rc" '1'
check 'no archive: says so' "$(printf '%s' "$err" | grep -c 'a release build needs the release archive')" '1'
check 'no archive: no plan written' "$(test -e "$plan_file" && echo written || echo none)" 'none'
write "$d5/.changeset/pre.json" '{ "mode": "pre", "tag": "rc" }'
run_plan --root "$d5" --mode release --archive "$tmp/archive-release"
check 'no plan: exit 1' "$rc" '1'
check 'no plan: says so' "$(printf '%s' "$err" | grep -c 'a release build needs the changesets plan')" '1'

echo "== unusable input (exit 2) =="

run_plan --root "$d"
check 'a main build needs a counter' "$rc" '2'
run_plan --root "$d" --counter 0412
check 'a counter is a numeric identifier without a leading zero' "$rc" '2'
run_plan --root "$d" --counter 5 --archivee "$tmp"
check 'an unknown argument' "$rc" '2'
run_plan --root "$d" --counter
check 'a flag without its argument' "$rc" '2'
run_plan --root "$d" --counter 5 --mode nightly
check 'an unknown mode' "$rc" '2'
d6="$(new_tree prerelease-manifest)"
add_qadam "$d6" core slack 0.4.15-main.3
run_plan --root "$d6" --counter 5
check 'a manifest that is not a released version' "$rc" '2'

echo "== every version against the one parser (qadamVersionParser) =="

run_plan --root "$d" --counter 412
if command -v bun >/dev/null 2>&1 && [ -f "$parser" ]; then
  parsed="$(PLAN="$plan_file" PARSER="$parser" bun --eval "
    import { readFileSync } from 'node:fs'
    const { qadamVersionParser } = await import(process.env.PARSER)
    const plan = JSON.parse(readFileSync(process.env.PLAN, 'utf8'))
    const bad = plan.packages.filter((entry) => {
      const parsed = qadamVersionParser.parse({ version: entry.version })
      const isSnapshot = entry.version !== entry.released
      return parsed === null || (isSnapshot ? parsed.snapshot !== 412 : parsed.snapshot !== null)
    })
    console.log(bad.length)
  " 2>&1)"
  check 'every planned version parses; a snapshot carries the counter, a release none' "$parsed" '0'
else
  printf 'SKIP  parser cross-check: needs bun\n'
fi

echo "== this tree =="

run_plan --root "$repo_root" --counter 7
check 'the repository plans without error' "$rc" '0'
check 'every official qadam is in the plan' "$(plan_field 'p.packages.length === require("fs").readdirSync("'"$repo_root"'/packages/qadams/core").concat(require("fs").readdirSync("'"$repo_root"'/packages/qadams/community")).length')" 'true'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
