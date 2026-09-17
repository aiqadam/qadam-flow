#!/usr/bin/env bash
#
# Tests for the migration-metadata gate (#445): tools/scripts/check-migration-rollback.ts
# is the only thing standing between a new migration and a `breaking`/`release`/
# `down()`/`name` that packages/server/api/src/app/database/rollback-migrations.ts
# silently mis-reads at rollback time — see the "Why the metadata matters"
# section of #445.
#
# Two layers, because a bug in either one makes the gate pass identically to a
# gate that checks nothing:
#
#   1. `validateMigrationInstance()`'s field-by-field logic — pinned via
#      tools/ci/check-migration-rollback-cases.ts, which the case below runs
#      through ts-node.
#   2. `getChangedMigrationFiles()` — the PR_BASE_SHA...PR_HEAD_SHA diff and
#      the MIGRATION_DIRS filter that decides WHICH files layer 1 ever sees.
#      This is real behaviour this PR introduced (the exact-SHA range, the
#      fallback, --no-renames) and nothing exercised it: if the range is ever
#      wrong, the script prints "No new migration files detected." and exits
#      0 — green, the same failure mode .agents/docs/verification-pitfalls.md
#      warns about. Exercised here the same way tools/ci/test-breaking-change-gate.sh
#      exercises its own git-log reader: a real throwaway git worktree, real
#      commits, nothing stubbed. A worktree (not an independent temp repo,
#      unlike that sibling test) because checkMigrationFile() resolves the
#      migration file it imports relative to its OWN location on disk
#      (`path.resolve(__dirname, '../..')`), so the fixture has to be a real
#      checkout of this repo for the dynamic import to find it.
#
# Runs from the `Lint + Unit Tests` job (_verify.yml), after install: both
# layers need ts-node/semver from node_modules, so this cannot join the
# pure-shell suite that runs before any install.
#
#   tools/ci/test-check-migration-rollback.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/../.." && pwd)"
gate_rel='tools/scripts/check-migration-rollback.ts'
migration_dir_rel='packages/server/api/src/app/database/migration/postgres'

pass=0
fail=0

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
}

ok() {
  pass=$((pass + 1))
  printf 'PASS  %s\n' "$1"
}

echo '== layer 1: validateMigrationInstance() field cases =='
if (cd "$repo_root" && npx ts-node --project tools/tsconfig.tools.json tools/ci/check-migration-rollback-cases.ts); then
  ok 'validateMigrationInstance() cases'
else
  fail_case 'validateMigrationInstance() cases' 'tools/ci/check-migration-rollback-cases.ts exited non-zero'
fi

echo
echo '== layer 2: getChangedMigrationFiles() diff-scoping (real git worktree) =='

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@example.invalid'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@example.invalid'

worktree="$(mktemp -d)"
base_sha="$(git -C "$repo_root" rev-parse HEAD)"

cleanup() {
  git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1
  rm -rf "$worktree"
  git -C "$repo_root" worktree prune >/dev/null 2>&1
}
trap cleanup EXIT

if ! git -C "$repo_root" worktree add --detach -q "$worktree" "$base_sha" 2>/dev/null; then
  fail_case 'git worktree setup' "could not create a worktree at ${worktree} from ${base_sha}"
else
  ln -s "${repo_root}/node_modules" "${worktree}/node_modules"

  # reset_worktree — back to base_sha with no fixture commits, so each case's
  # add_fixture() diffs base_sha...<its own commit> in isolation, not against
  # every fixture a prior case also committed on top of the same worktree.
  reset_worktree() {
    git -C "$worktree" reset -q --hard "$base_sha"
    git -C "$worktree" clean -q -fd
  }

  # add_fixture <basename> <extra-field-lines...> — writes a migration file
  # implementing `up()`+`down()` (so it always compiles against typeorm's
  # non-optional MigrationInterface.down) plus whatever metadata lines the
  # caller supplies, and commits it.
  add_fixture() {
    local basename="$1"
    shift
    local file="${worktree}/${migration_dir_rel}/${basename}.ts"
    {
      printf "import { QueryRunner } from 'typeorm'\n"
      printf "import { Migration } from '../../migration'\n\n"
      printf 'export class %s implements Migration {\n' "$basename"
      for line in "$@"; do
        printf '    %s\n' "$line"
      done
      printf '    public async up(queryRunner: QueryRunner): Promise<void> {\n'
      printf "        await queryRunner.query('SELECT 1')\n"
      printf '    }\n\n'
      printf '    public async down(queryRunner: QueryRunner): Promise<void> {\n'
      printf "        await queryRunner.query('SELECT 1')\n"
      printf '    }\n'
      printf '}\n'
    } > "$file"
    git -C "$worktree" add -A -- "$file"
    git -C "$worktree" commit -q --no-gpg-sign --no-verify -m "fixture: ${basename}"
    git -C "$worktree" rev-parse HEAD
  }

  # run_gate <head-sha> — runs the gate against base_sha...<head-sha>, captures
  # combined output, returns the gate's exit code via $?.
  run_gate() {
    (cd "$worktree" && PR_BASE_SHA="$base_sha" PR_HEAD_SHA="$1" \
      npx ts-node --project tools/tsconfig.tools.json "$gate_rel") 2>&1
  }

  # --- case: no new migration files -> exits 0, reports nothing to check ---
  out="$(run_gate "$base_sha")"
  rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qF 'No new migration files detected.'; then
    ok 'no new migration files -> exit 0'
  else
    fail_case 'no new migration files -> exit 0' "want rc=0 with the no-op message, got rc=${rc}" "$out"
  fi

  # --- case: new migration missing `breaking` -> exits 1, names the field ---
  reset_worktree
  head_sha="$(add_fixture 'Bad9999999999997' "name = 'Bad9999999999997'" "release = '1.0.0'")"
  out="$(run_gate "$head_sha")"
  rc=$?
  if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -qF '"breaking"'; then
    ok 'missing breaking -> exit 1, names the field'
  else
    fail_case 'missing breaking -> exit 1, names the field' "want rc=1 mentioning \"breaking\", got rc=${rc}" "$out"
  fi

  # --- case: `name` set but doesn't match the exported class -> exits 1 ---
  reset_worktree
  head_sha="$(add_fixture 'Mismatch9999999999995' "name = 'SomeOtherName'" 'breaking = false' "release = '1.0.0'")"
  out="$(run_gate "$head_sha")"
  rc=$?
  if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -qF 'does not match the exported class name'; then
    ok 'name mismatched with class name -> exit 1'
  else
    fail_case 'name mismatched with class name -> exit 1' "want rc=1 mentioning the mismatch, got rc=${rc}" "$out"
  fi

  # --- case: fully valid new migration -> exits 0 ---
  reset_worktree
  head_sha="$(add_fixture 'Good9999999999996' "name = 'Good9999999999996'" 'breaking = false' "release = '1.0.0'")"
  out="$(run_gate "$head_sha")"
  rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qF 'All migration rollback checks passed.'; then
    ok 'fully valid migration -> exit 0'
  else
    fail_case 'fully valid migration -> exit 0' "want rc=0, got rc=${rc}" "$out"
  fi
fi

echo
if [ "$fail" -gt 0 ]; then
  printf '%d/%d case(s) failed.\n' "$fail" "$((pass + fail))"
  exit 1
fi
printf 'All %d case(s) passed.\n' "$pass"
