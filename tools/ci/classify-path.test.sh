#!/usr/bin/env bash
#
# Tests for the CI docs-only path classifier (#132).
#
# Run from the `Lint + Unit Tests` job, which is unconditional. That placement
# is deliberate: this test guards the logic that decides whether
# `CE Integration Tests` runs at all, so it must never be skippable by the very
# filter it covers. Do not move it into the conditional integration job.
#
#   tools/ci/classify-path.test.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0

check_path() {
  local want="$1" path="$2" note="${3:-}" got
  got="$("${here}/classify-path.sh" "$path")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  path  want=%-4s got=%-4s  %s  %s\n' "$want" "$got" "$path" "$note"
  fi
}

# check_list <want docs_only> <note> <path>...
check_list() {
  local want="$1" note="$2" list got
  shift 2
  list="$(mktemp)"
  printf '%s\n' "$@" > "$list"
  got="$("${here}/classify-changed-paths.sh" "$list" 2>/dev/null)"
  rm -f "$list"
  if [ "$got" = "docs_only=$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  list  want=docs_only=%-5s got=%-16s  %s\n' "$want" "$got" "$note"
  fi
}

echo "== single-path classification =="

# --- prose that should skip the suite ---
check_path docs README.md
check_path docs CONTRIBUTING.md
check_path docs GOVERNANCE.md
check_path docs CODE_OF_CONDUCT.md
check_path docs AGENTS.md
check_path docs CLAUDE.md                       "root symlink to AGENTS.md, still prose"
check_path docs LICENSE
check_path docs docs/LICENSE
check_path docs docs/install/overview.mdx
check_path docs docs/docs.json                  "named docs-site nav config"
check_path docs docs/openapi.json               "named docs-site api spec"
check_path docs docs/resources/screenshots/a.png
check_path docs docs/resources/passing-data.gif
check_path docs docs/resources/passing-data.mp4
check_path docs docs/resources/logo/dark.svg
check_path docs assets/ap-logo.png
check_path docs .agents/features/alerts.md
check_path docs .agents/skills/db-migration/SKILL.md
check_path docs .claude/rules/data-isolation.md

# --- the narrowing this test exists to lock in: non-prose under docs/ and
# --- .agents/ must NOT be waved through by a directory allowlist ---
check_path code docs/scripts/gen.js             "narrowed: no wholesale docs/** arm"
check_path code docs/scripts/validate.mjs       "narrowed: the latent-risk case"
check_path code .agents/script.sh               "narrowed: no wholesale .agents/** arm"
check_path code .agents/skills/mcp-builder/scripts/evaluation.py
check_path code .agents/skills/agent-browser/templates/capture-workflow.sh
check_path code .agents/skills/mcp-builder/scripts/requirements.txt
check_path code docs/package.json               "denylist beats docs/ prefix"
check_path code docs/tsconfig.json
check_path code docs/Dockerfile

# --- symlinked markdown must not widen the allowlist ---
check_path code packages/server/CLAUDE.md       "symlink under packages/"
check_path code packages/server/AGENTS.md       "symlink target under packages/"
check_path code packages/README.md
check_path code packages/qadams/community/x/README.md
check_path code packages/shared/src/index.ts
check_path code packages

# --- the pipeline must validate its own changes ---
check_path code .github/workflows/ci.yml
check_path code .github/notes.md                "a .md under .github is still pipeline"
check_path code .github/dependabot.yml
check_path code .github

# --- build, deps, config, env ---
check_path code run.sh
check_path code docker-compose.yml
check_path code docker-compose.dev.yml
check_path code Dockerfile
check_path code docker-entrypoint.sh
check_path code package.json
check_path code packages/web/package.json
check_path code bun.lock
check_path code package-lock.json
check_path code turbo.json
check_path code tsconfig.base.json
check_path code .env.dev
check_path code .env.tests
check_path code .dockerignore
check_path code .eslintrc.json

# --- the classifier's own source must force the full suite ---
check_path code tools/ci/classify-path.sh
check_path code tools/ci/classify-changed-paths.sh
check_path code tools/scripts/install-bun.js

# --- unrecognised shapes fall through to code ---
check_path code Makefile
check_path code some-new-toplevel-dir/thing.rb
check_path code CHANGELOG                       "no extension, not LICENSE"
check_path code "docs/notes.md.bak"
check_path code ""                              "empty path"

# --- awkward filenames stay classifiable, and quoted paths fail closed ---
check_path docs "docs/a file with spaces.md"
check_path docs "docs/tabbed	name.md"
check_path code '"docs/caf\303\251.md"'         "git-quoted non-ASCII path fails closed"
check_path code '"packages/x.md"'
check_path docs "docs/über.md"                  "unquoted UTF-8 still matches *.md"

echo "== whole-diff verdicts =="

check_list true  "genuine docs-only diff" \
  "docs/install/overview.mdx" "README.md" "docs/docs.json" ".agents/features/x.md"

check_list false "single code path among docs" \
  "docs/install/overview.mdx" "packages/shared/src/index.ts"

check_list false "code -> docs rename (--no-renames yields both paths)" \
  "packages/shared/src/old-helper.ts" "docs/reference/old-helper.md"

check_list false "docs -> code rename" \
  "docs/reference/thing.md" "packages/shared/src/thing.ts"

check_list false "docs/package.json alone" "docs/package.json"
check_list false ".github/notes.md alone" ".github/notes.md"
check_list false "packages/ .md alone" "packages/server/CLAUDE.md"
check_list false "unrecognised extension under packages/" "packages/ci-proof.txt"
check_list false "new executable under docs/" "docs/scripts/validate.mjs"

check_list true  "path with a space, docs-only" "docs/a file with spaces.md"
check_list false "quoted non-ASCII path" '"docs/caf\303\251.md"'

echo "== fail-closed guards =="

guard() {
  local want="$1" note="$2" list="$3" got
  got="$("${here}/classify-changed-paths.sh" "$list" 2>/dev/null)"
  if [ "$got" = "docs_only=$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  guard want=docs_only=%-5s got=%-16s  %s\n' "$want" "$got" "$note"
  fi
}

empty_list="$(mktemp)"
: > "$empty_list"
guard false "empty changed-path list" "$empty_list"
rm -f "$empty_list"

blank_list="$(mktemp)"
printf 'docs/a.md\n\ndocs/b.md\n' > "$blank_list"
guard false "blank line inside an otherwise docs-only list" "$blank_list"
rm -f "$blank_list"

# grep -c counts the unterminated fragment, but `read` drops it, so classified
# < expected. This is the count-mismatch guard firing on real input.
unterminated="$(mktemp)"
printf 'docs/a.md\ndocs/b.md' > "$unterminated"
guard false "unterminated final line trips the count check" "$unterminated"
rm -f "$unterminated"

missing="$(mktemp -u)"
guard false "missing list file" "$missing"

guard false "no argument at all" ""

# Sanity: the count guard must not fire on well-formed input, or every diff
# would be classified as code and the filter would be dead weight.
wellformed="$(mktemp)"
printf 'docs/a.md\ndocs/b.md\n' > "$wellformed"
guard true "well-formed docs-only list is not tripped by the guards" "$wellformed"
rm -f "$wellformed"

echo "== large diff =="

big="$(mktemp)"
for i in $(seq 1 5000); do echo "docs/page-${i}.mdx"; done > "$big"
guard true "5000 docs paths" "$big"
echo "packages/shared/src/index.ts" >> "$big"
guard false "5000 docs paths + 1 code path" "$big"
rm -f "$big"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "CI path classifier tests FAILED — the docs-only filter is not trustworthy until this is green."
  exit 1
fi
echo "CI path classifier tests passed."
