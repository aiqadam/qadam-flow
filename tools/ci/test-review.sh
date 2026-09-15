#!/usr/bin/env bash
#
# Tests for tools/scripts/review.mjs and the pre-push [r]eview branch (#444).
#
# The dispatcher's entire job is to behave correctly when the environment is
# half-configured, so every combination is pinned with stub `ocr`/agent CLIs
# instead of the real ones: no ocr at all, ocr without an endpoint, ocr with an
# endpoint, delegation through an agent CLI, and a review that fails for an
# unrelated reason. The hook cases pin the two things it must never do — run
# the review inside the y/lint gate, and block a push when the review is merely
# unavailable — plus the one thing it may do: stop on `critical` findings.
#
# CI placement: after `actions/setup-node` in .github/workflows/_verify.yml.
# The subject is a node script, so it cannot sit with the pure-shell suites
# that run before any toolchain install.
#
#   tools/ci/test-review.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
subject="${root}/tools/scripts/review.mjs"
hook="${root}/.husky/pre-push"

pass=0
fail=0

ok_case() {
  pass=$((pass + 1))
}

fail_case() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
}

expect_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then
    ok_case
  else
    fail_case "$3" "expected output to contain: $2" "actual: $1"
  fi
}

expect_not_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then
    fail_case "$3" "expected output NOT to contain: $2" "actual: $1"
  else
    ok_case
  fi
}

expect_equal() {
  if [ "$1" = "$2" ]; then
    ok_case
  else
    fail_case "$3" "want '$2', got '$1'"
  fi
}

expect_file_contains() {
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then
    ok_case
  else
    fail_case "$3" "expected file $1 to contain: $2" "$([ -f "$1" ] && cat "$1" || echo '<missing>')"
  fi
}

expect_file_missing() {
  if [ -e "$1" ]; then
    fail_case "$2" "did not expect $1 to exist" "$(cat "$1" 2>/dev/null)"
  else
    ok_case
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export NO_COLOR=1

# ── fixtures ────────────────────────────────────────────────────────────────

repo="$tmp/repo"
mkdir -p "$repo/packages/server/api/src/app"
git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf 'export const x = 1\n' > "$repo/packages/server/api/src/app/svc.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm init
printf 'export const x = 2\n' > "$repo/packages/server/api/src/app/svc.ts"

cat > "$tmp/ocr" <<'SH'
#!/bin/sh
# Stub ocr. OCR_STUB_REVIEW=ok|noendpoint|error; OCR_STUB_CRITICAL=1 adds a
# critical finding; delegate subcommands cat the JSON fixtures below.
printf '%s\n' "$*" >> "$OCR_STUB_LOG"
case "$1 $2" in
  "--version "*)
    echo "open-code-review v0.0.0 (stub)"; exit 0 ;;
  "review --format")
    out=""
    prev=""
    for arg in "$@"; do
      [ "$prev" = "--output" ] && out="$arg"
      prev="$arg"
    done
    case "${OCR_STUB_REVIEW:-ok}" in
      noendpoint)
        echo "Error: resolve LLM endpoint: no valid LLM endpoint configured; one of OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL must be set" >&2
        exit 1 ;;
      error)
        echo "Error: the endpoint rejected the request" >&2
        exit 1 ;;
    esac
    if [ "${OCR_STUB_BIG:-0}" = "1" ]; then
      # Larger than a pipe buffer, to catch a report truncated by an early exit.
      big="$(head -c 300000 /dev/zero | tr '\0' 'x')"
      printf '{"status":"success","comments":[{"path":"packages/server/api/src/app/svc.ts","content":"%s","severity":"low"}]}\n' "$big" > "$out"
      exit 0
    fi
    if [ "${OCR_STUB_CRITICAL:-0}" = "1" ]; then
      cat > "$out" <<'JSON'
{"status":"success","summary":{"comments":1},"comments":[{"path":"packages/server/api/src/app/svc.ts","content":"query is not tenant-scoped","severity":"critical","category":"security","start_line":1,"end_line":1}]}
JSON
    else
      cat > "$out" <<'JSON'
{"status":"success","summary":{"comments":1},"comments":[{"path":"packages/server/api/src/app/svc.ts","content":"name could be clearer","severity":"low","category":"style","start_line":1,"end_line":1}]}
JSON
    fi
    exit 0 ;;
  "delegate preview")
    cat "$OCR_STUB_PREVIEW"; exit 0 ;;
  "delegate rule")
    cat "$OCR_STUB_RULES"; exit 0 ;;
esac
echo "unexpected stub ocr invocation: $*" >&2
exit 1
SH
chmod +x "$tmp/ocr"

cat > "$tmp/opencode" <<'SH'
#!/bin/sh
# Stub agent CLI. Appends the prompt it received (separated, so batching can be
# asserted); AGENT_STUB_CRITICAL=1 emits a critical finding between the markers
# the dispatcher parses; AGENT_STUB_FAIL=1 simulates a broken agent.
[ "$1" = "run" ] || { echo "expected 'run', got '$1'" >&2; exit 2; }
printf '\n<<<PROMPT>>>\n' >> "$AGENT_STUB_PROMPT"
printf '%s' "$2" >> "$AGENT_STUB_PROMPT"
if [ "${AGENT_STUB_FAIL:-0}" = "1" ]; then
  echo "agent exploded" >&2
  exit 1
fi
printf 'progress noise\n'
echo "<review-findings>"
if [ "${AGENT_STUB_CRITICAL:-0}" = "1" ]; then
  echo '{"comments":[{"path":"packages/server/api/src/app/svc.ts","content":"agent found a tenant leak","severity":"critical","category":"security"}]}'
else
  echo '{"comments":[]}'
fi
echo "</review-findings>"
SH
chmod +x "$tmp/opencode"

bin_lonely="$tmp/bin-lonely"
bin_ocr="$tmp/bin-ocr"
bin_full="$tmp/bin-full"
mkdir -p "$bin_lonely" "$bin_ocr" "$bin_full"
for dir in "$bin_lonely" "$bin_ocr" "$bin_full"; do
  ln -s "$(command -v node)" "$dir/node"
done
cp "$tmp/ocr" "$bin_ocr/ocr"
cp "$tmp/ocr" "$bin_full/ocr"
cp "$tmp/opencode" "$bin_full/opencode"

cat > "$tmp/preview.json" <<JSON
{
  "schema_version": "1",
  "mode": "workspace",
  "repository": "$repo",
  "total_files": 2,
  "reviewable_count": 1,
  "excluded_count": 1,
  "total_insertions": 1,
  "total_deletions": 1,
  "reviewable_files": [
    { "path": "packages/server/api/src/app/svc.ts", "status": "modified", "insertions": 1, "deletions": 1 }
  ],
  "excluded_files": [
    { "path": "docs/x.mdx", "status": "modified", "insertions": 1, "deletions": 0, "exclude_reason": "user_exclude" }
  ]
}
JSON

cat > "$tmp/rules.json" <<'JSON'
{
  "schema_version": "1",
  "groups": [
    {
      "group_id": 1,
      "source": "project",
      "pattern": "packages/server/**/*.ts",
      "files": ["packages/server/api/src/app/svc.ts"],
      "rule": "Every query must filter by projectId."
    }
  ]
}
JSON

# A second, two-group fixture: the dispatcher must not put files with different
# rules into one agent call, or the second file is reviewed against the first
# file's rule. (The live review of this very script found that bug.)
mkdir -p "$repo/packages/web/src"
printf 'export const y = 1\n' > "$repo/packages/web/src/thing.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm web
printf 'export const y = 2\n' > "$repo/packages/web/src/thing.ts"

cat > "$tmp/preview-batch.json" <<JSON
{
  "schema_version": "1",
  "mode": "workspace",
  "repository": "$repo",
  "total_files": 2,
  "reviewable_count": 2,
  "excluded_count": 0,
  "total_insertions": 2,
  "total_deletions": 2,
  "reviewable_files": [
    { "path": "packages/server/api/src/app/svc.ts", "status": "modified", "insertions": 1, "deletions": 1 },
    { "path": "packages/web/src/thing.ts", "status": "modified", "insertions": 1, "deletions": 1 }
  ],
  "excluded_files": []
}
JSON

cat > "$tmp/rules-batch.json" <<'JSON'
{
  "schema_version": "1",
  "groups": [
    {
      "group_id": 1,
      "source": "project",
      "pattern": "packages/server/**/*.ts",
      "files": ["packages/server/api/src/app/svc.ts"],
      "rule": "RULE-ALPHA: every query must filter by projectId."
    },
    {
      "group_id": 2,
      "source": "project",
      "pattern": "packages/web/**/*.ts",
      "files": ["packages/web/src/thing.ts"],
      "rule": "RULE-BETA: every query needs meta.showErrorDialog."
    }
  ]
}
JSON

export OCR_STUB_LOG="$tmp/ocr.log"
export OCR_STUB_PREVIEW="$tmp/preview.json"
export OCR_STUB_RULES="$tmp/rules.json"
export AGENT_STUB_PROMPT="$tmp/agent-prompt.txt"

# review <bin-dir> [flags...] — runs the subject inside the fixture repo and
# leaves: $status, $out, $artifact. Stub behaviour comes from the environment.
review() {
  local bin="$1"
  shift
  # Deliberately a pipe, not a plain file redirect: the subject's exit path must
  # not truncate the report when stdout is a pipe (the hook-in-IDE / CI case).
  ( cd "$repo" && PATH="$bin:$base_path" node "$subject" "$@" | cat ) > "$tmp/review.out" 2>&1
  status=$?
  out="$(cat "$tmp/review.out")"
  artifact="$repo/.git/qadam-review/last.json"
}

reset_review_env() {
  export OCR_STUB_REVIEW=ok
  export OCR_STUB_CRITICAL=0
  export OCR_STUB_BIG=0
  export AGENT_STUB_CRITICAL=0
  export AGENT_STUB_FAIL=0
  export OCR_STUB_PREVIEW="$tmp/preview.json"
  export OCR_STUB_RULES="$tmp/rules.json"
  rm -f "$repo/.git/qadam-review/last.json" "$AGENT_STUB_PROMPT"
}

# `node` is symlinked into each stub dir, so the restricted PATH below stays
# genuinely restricted: npm's global bin (which contains the real `ocr` on a
# developer machine) is deliberately not on it. Only system tools the subject
# spawns — git — come from /usr/bin.
base_path="/usr/bin:/bin"

echo "== no ocr and no agent CLI: advisory skip, nothing blocked =="

reset_review_env
rm -f "$OCR_STUB_LOG"
review "$bin_lonely"
expect_equal "$status" "0" "no-ocr: exit 0 (advisory)"
expect_contains "$out" "ocr is not installed" "no-ocr: hint names the missing CLI"
expect_contains "$out" "npm i -g @alibaba-group/open-code-review" "no-ocr: hint gives the install command"
expect_contains "$out" "advisory" "no-ocr: message says it is advisory"
expect_file_missing "$artifact" "no-ocr: no artifact on a skip"

echo "== ocr without an endpoint and no agent: hint, exit 0 =="

reset_review_env
export OCR_STUB_REVIEW=noendpoint
review "$bin_ocr"
expect_equal "$status" "0" "no-endpoint: exit 0 (advisory)"
expect_contains "$out" "no LLM endpoint configured" "no-endpoint: names the cause"
expect_contains "$out" "agent CLI" "no-endpoint: names the delegation escape hatch"

echo "== ocr without an endpoint plus an agent CLI: delegation =="

reset_review_env
export OCR_STUB_REVIEW=noendpoint
export AGENT_STUB_CRITICAL=1
rm -f "$OCR_STUB_LOG"
review "$bin_full"
expect_equal "$status" "2" "delegation: critical findings exit 2"
expect_contains "$out" "falling back to delegation via opencode" "delegation: fallback is announced"
expect_contains "$out" "CRITICAL" "delegation: finding is printed"
expect_file_contains "$artifact" '"backend": "delegation(opencode)"' "delegation: artifact records the backend"
expect_file_contains "$artifact" '"critical": 1' "delegation: artifact counts the critical"
expect_file_contains "$AGENT_STUB_PROMPT" "Every query must filter by projectId." "delegation: prompt carries the project rule"
expect_file_contains "$AGENT_STUB_PROMPT" "+export const x = 2" "delegation: prompt carries the diff"
expect_file_contains "$OCR_STUB_LOG" "delegate preview --format json" "delegation: preview comes from ocr"

echo "== delegation batches by rule, not just by size =="

reset_review_env
export OCR_STUB_REVIEW=noendpoint
export OCR_STUB_PREVIEW="$tmp/preview-batch.json"
export OCR_STUB_RULES="$tmp/rules-batch.json"
review "$bin_full"
expect_equal "$status" "0" "batching: exit 0"
prompts="$(grep -c '<<<PROMPT>>>' "$AGENT_STUB_PROMPT" 2>/dev/null || true)"
expect_equal "$prompts" "2" "batching: one agent call per rule group"
first="$(awk '/<<<PROMPT>>>/{n++} n==1' "$AGENT_STUB_PROMPT")"
second="$(awk '/<<<PROMPT>>>/{n++} n==2' "$AGENT_STUB_PROMPT")"
expect_contains "$first" "RULE-ALPHA" "batching: the ALPHA batch carries its own rule"
expect_not_contains "$first" "RULE-BETA" "batching: the ALPHA batch must not carry BETA"
expect_contains "$second" "RULE-BETA" "batching: the BETA batch carries its own rule"
expect_not_contains "$second" "RULE-ALPHA" "batching: the BETA batch must not carry ALPHA"

echo "== ocr with an endpoint: ocr-managed, no agent needed =="

reset_review_env
export OCR_STUB_BIG=1
review "$bin_ocr"
expect_equal "$status" "0" "large report: exit 0"
expect_contains "$out" "[review] findings:" "large report: the summary survives a pipe"
expect_contains "$out" "[review] artifact: .git/qadam-review/last.json" "large report: the artifact line survives a pipe"

reset_review_env
export OCR_STUB_CRITICAL=1
review "$bin_ocr"
expect_equal "$status" "2" "ocr-managed: critical findings exit 2"
expect_contains "$out" "backend: ocr-managed" "ocr-managed: backend is named"
expect_file_contains "$artifact" '"backend": "ocr-managed"' "ocr-managed: artifact records the backend"

reset_review_env
review "$bin_full" --json
expect_equal "$status" "0" "ocr-managed: no criticals exit 0"
if printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.backend==="ocr-managed"&&j.counts.critical===0&&j.counts.total===1?0:1)})'; then
  ok_case
else
  fail_case "ocr-managed --json: stdout is the parseable artifact" "$out"
fi
expect_file_missing "$AGENT_STUB_PROMPT" "ocr-managed: agent CLI must not be invoked when ocr is configured"

echo "== delegation records only batches that actually answered =="

reset_review_env
export OCR_STUB_REVIEW=noendpoint
export AGENT_STUB_FAIL=1
review "$bin_full"
expect_equal "$status" "0" "agent failure: advisory exit 0"
expect_contains "$out" "warning:" "agent failure: reported as a warning"
if node -e '
const fs = require("fs")
const artifact = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
process.exit(artifact.reviewed_files.length === 0 && artifact.warnings.length > 0 ? 0 : 1)
' "$artifact"; then
  ok_case
else
  fail_case "agent failure: reviewed_files must not claim unreviewed files" "$(cat "$artifact")"
fi

echo "== delegation carries background context from -B =="

reset_review_env
export OCR_STUB_REVIEW=noendpoint
printf 'TICKET-CONTEXT-MARKER: the sync webhook must not hang.\n' > "$tmp/context.md"
# The stub ocr echoes the resolved background in its preview JSON, exactly as
# the real `delegate preview -B context.md` does.
sed 's|"mode": "workspace",|"mode": "workspace", "background": "TICKET-CONTEXT-MARKER: the sync webhook must not hang.",|' \
  "$tmp/preview.json" > "$tmp/preview-bg.json"
if ! grep -q 'TICKET-CONTEXT-MARKER' "$tmp/preview-bg.json"; then
  fail_case "background-file: the fixture was not patched"
fi
export OCR_STUB_PREVIEW="$tmp/preview-bg.json"
rm -f "$OCR_STUB_LOG"
review "$bin_full" -B "$tmp/context.md"
expect_equal "$status" "0" "background-file: exit 0"
expect_file_contains "$AGENT_STUB_PROMPT" "TICKET-CONTEXT-MARKER" "background-file: context reaches the prompt"
# Anchored to the delegate line: the failed ocr-managed attempt also carries -B,
# so an unanchored grep would pass even if delegation dropped it.
if grep -F 'delegate preview' "$OCR_STUB_LOG" | grep -qF -- "-B $tmp/context.md"; then
  ok_case
else
  fail_case "background-file: -B must reach the delegate preview call" "$(cat "$OCR_STUB_LOG")"
fi

echo "== a broken ocr must not silently fall back to delegation =="

reset_review_env
export OCR_STUB_REVIEW=error
review "$bin_full"
expect_equal "$status" "1" "ocr failure: exit 1 (advisory failure, not skip)"
expect_contains "$out" "review failed" "ocr failure: reported as a failure"
expect_not_contains "$out" "delegation" "ocr failure: no silent fallback"

echo "== forced backends that cannot be satisfied are errors, not skips =="

reset_review_env
review "$bin_lonely" --mode delegate
expect_equal "$status" "1" "--mode delegate without ocr: exit 1"
export OCR_STUB_REVIEW=noendpoint
review "$bin_ocr" --mode ocr
expect_equal "$status" "1" "--mode ocr without endpoint: exit 1"
reset_review_env
review "$bin_lonely" --agent nope
expect_equal "$status" "1" "unknown --agent: usage error"
review "$bin_ocr" --agent claude
expect_equal "$status" "1" "--agent claude without claude on PATH: exit 1"
review "$bin_ocr" --to HEAD
expect_equal "$status" "1" "--to without --from: usage error"
review "$bin_ocr" --commit abc1234 --to HEAD
expect_equal "$status" "1" "--to with --commit: usage error"

echo "== --preview: no LLM, lists what would be reviewed =="

reset_review_env
rm -f "$OCR_STUB_LOG"
review "$bin_ocr" --preview
expect_equal "$status" "0" "--preview: exit 0"
expect_contains "$out" "preview: workspace" "--preview: mode is printed"
expect_contains "$out" "review  packages/server/api/src/app/svc.ts" "--preview: reviewable file is listed"
expect_contains "$out" "skip    docs/x.mdx (user_exclude)" "--preview: excluded file and reason are listed"
expect_contains "$out" "rule    1 file(s) <- project:packages/server/**/*.ts" "--preview: resolved rule is shown"
if grep -q "^review --format" "$OCR_STUB_LOG"; then
  fail_case "--preview: must not start a review"
else
  ok_case
fi

echo "== --emit-prompts: delegation prompts to files, no LLM and no agent =="

reset_review_env
rm -f "$OCR_STUB_LOG"
emit_dir="$tmp/prompts"
review "$bin_full" --emit-prompts "$emit_dir"
expect_equal "$status" "0" "emit: exit 0"
expect_contains "$out" "emitted 1 prompt(s) for 1 file(s)" "emit: summary names the prompt and file counts"
expect_file_contains "$emit_dir/batch-01.prompt.md" "Every query must filter by projectId." "emit: prompt carries the project rule"
expect_file_contains "$emit_dir/batch-01.prompt.md" "+export const x = 2" "emit: prompt carries the diff"
expect_file_contains "$emit_dir/batch-01.prompt.md" "<review-findings>" "emit: prompt keeps the findings contract"
expect_file_contains "$emit_dir/manifest.json" '"prompt_file": "batch-01.prompt.md"' "emit: manifest lists the prompt file"
expect_file_contains "$emit_dir/manifest.json" '"reason": "user_exclude"' "emit: manifest keeps the exclusion reasons"
expect_file_missing "$AGENT_STUB_PROMPT" "emit: no agent CLI is invoked"
expect_file_missing "$artifact" "emit: no findings artifact is written"
if grep -q "^review --format" "$OCR_STUB_LOG"; then
  fail_case "emit: must not start an ocr review (no endpoint needed)" "$(cat "$OCR_STUB_LOG")"
else
  ok_case
fi

echo "== --emit-prompts: batching, stale cleanup, error paths =="

reset_review_env
rm -rf "$emit_dir"
export OCR_STUB_PREVIEW="$tmp/preview-batch.json"
export OCR_STUB_RULES="$tmp/rules-batch.json"
review "$bin_full" --emit-prompts "$emit_dir" --json
expect_equal "$status" "0" "emit batching: exit 0"
expect_file_contains "$emit_dir/batch-01.prompt.md" "RULE-ALPHA" "emit batching: the first rule gets its own prompt"
expect_file_contains "$emit_dir/batch-02.prompt.md" "RULE-BETA" "emit batching: the second rule gets its own prompt"
if printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(j.batches.length===2&&j.batches[1].prompt_file==="batch-02.prompt.md"&&j.target.merge_base===null?0:1)})'; then
  ok_case
else
  fail_case "emit batching --json: stdout is the parseable manifest with both batches" "$out"
fi

reset_review_env
review "$bin_full" --emit-prompts "$emit_dir"
expect_equal "$status" "0" "emit second run: exit 0"
expect_file_missing "$emit_dir/batch-02.prompt.md" "emit second run: a stale prompt from the previous emit is removed"

foreign_dir="$tmp/foreign-prompts"
mkdir -p "$foreign_dir"
printf '{"unrelated": true}\n' > "$foreign_dir/manifest.json"
review "$bin_full" --emit-prompts "$foreign_dir"
expect_equal "$status" "1" "emit into a dir with a foreign manifest: exit 1"
expect_contains "$out" "was not written by this tool" "emit: the refusal names the foreign manifest"
expect_file_contains "$foreign_dir/manifest.json" '"unrelated": true' "emit: the foreign manifest is left intact"

reset_review_env
review "$bin_ocr" --emit-prompts "$emit_dir" --preview
expect_equal "$status" "1" "emit + --preview: usage error"
expect_contains "$out" "cannot be combined" "emit + --preview: message names the conflict"
review "$bin_full" --emit-prompts "$emit_dir" --mode ocr
expect_equal "$status" "1" "emit + --mode: usage error"
review "$bin_full" --emit-prompts "$emit_dir" --agent opencode
expect_equal "$status" "1" "emit + --agent: usage error"
review "$bin_lonely" --emit-prompts "$emit_dir"
expect_equal "$status" "1" "emit without ocr: exit 1, not a silent skip"
expect_contains "$out" 'needs the `ocr` CLI' "emit without ocr: message names the missing CLI"

echo "== mode flags reach ocr unchanged =="

reset_review_env
rm -f "$OCR_STUB_LOG"
review "$bin_ocr" --from main
expect_equal "$status" "0" "range mode: exit 0"
expect_file_contains "$OCR_STUB_LOG" "review --format json --audience agent --output" "range mode: ocr review is invoked"
expect_file_contains "$OCR_STUB_LOG" "--from main --to HEAD" "range mode: --from/--to reach ocr"
review "$bin_ocr" --commit abc1234
expect_file_contains "$OCR_STUB_LOG" "--commit abc1234" "commit mode: --commit reaches ocr"

echo "== rule.json is loadable and its rule files exist =="

if node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const config = JSON.parse(fs.readFileSync(path.join(root, ".opencodereview/rule.json"), "utf8"))
const problems = []
if (!Array.isArray(config.rules) || config.rules.length === 0) problems.push("no rules")
for (const entry of config.rules ?? []) {
  if (!entry.path) problems.push("a rule entry has no path")
  if (!entry.rule) problems.push(`${entry.path}: no rule text or file`)
  else if (/^[^\s]+\.(md|txt|markdown)$/i.test(entry.rule) && !fs.existsSync(path.join(root, entry.rule))) {
    problems.push(`${entry.path}: rule file ${entry.rule} does not exist`)
  }
}
const excludes = (config.exclude ?? []).join("\n")
for (const required of ["**/i18n/**", "packages/web/public/locales/**"]) {
  if (!excludes.includes(required)) problems.push(`missing exclude ${required}`)
}
if (!(config.include ?? []).join("\n").includes("packages/server/api/test/**")) {
  problems.push("missing include for server api tests")
}
if (!(config.rules ?? []).some((entry) => entry.path.includes(".husky/"))) {
  problems.push("no rule covers .husky/**")
}
// OCR resolves exactly one project rule per file (first match wins) and
// merge_system_rule merges only the system layer, so any rule that a .ts path
// can match must carry the repo-wide conventions itself. This asserts the
// copies are byte-identical, so one edited without the others cannot ship.
const extractBlock = (file) => {
  const match = fs.readFileSync(file, "utf8").match(/<!-- repo-wide:start -->[\s\S]*?<!-- repo-wide:end -->/)
  return match ? match[0] : null
}
const reference = extractBlock(path.join(root, ".opencodereview/rules/90-typescript.md"))
if (!reference) problems.push("90-typescript.md has no repo-wide block")
for (const entry of config.rules ?? []) {
  if (!/\.tsx?/.test(entry.path)) continue
  if (!/\.(md|txt|markdown)$/i.test(entry.rule)) {
    problems.push(`${entry.path}: a TS rule should reference a rule file so the block can be kept in sync`)
    continue
  }
  const ruleFile = path.join(root, entry.rule)
  const block = fs.existsSync(ruleFile) ? extractBlock(ruleFile) : null
  if (block !== reference) problems.push(`${entry.rule}: repo-wide block missing or drifted from 90-typescript.md`)
}
if (problems.length > 0) { console.error(problems.join("\n")); process.exit(1) }
' "$root"; then
  ok_case
else
  fail_case "rule.json validation"
fi

echo "== pre-push hook: y / n / lint paths keep their behaviour and never review =="

hook_dir="$tmp/hook/.husky"
mkdir -p "$hook_dir/_"
cp "$hook" "$hook_dir/pre-push"
: > "$hook_dir/_/husky.sh"

hook_repo="$tmp/hook-repo"
mkdir -p "$hook_repo"
git -C "$hook_repo" init -q
git -C "$hook_repo" config user.email test@example.com
git -C "$hook_repo" config user.name Test
printf 'x\n' > "$hook_repo/file.txt"
git -C "$hook_repo" add -A
git -C "$hook_repo" commit -qm init

hook_bin="$tmp/hook-bin"
mkdir -p "$hook_bin"
cat > "$hook_bin/node" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_NODE_LOG"
exit "${STUB_NODE_EXIT:-0}"
SH
cat > "$hook_bin/npm" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_NPM_LOG"
exit 0
SH
cat > "$hook_bin/npx" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_NPX_LOG"
exit 0
SH
chmod +x "$hook_bin/node" "$hook_bin/npm" "$hook_bin/npx"
export STUB_NODE_LOG="$tmp/stub-node.log"
export STUB_NPM_LOG="$tmp/stub-npm.log"
export STUB_NPX_LOG="$tmp/stub-npx.log"

# run_hook <answer> <stub-node-exit> — leaves $status and $out. The hook is run
# with stdout on a pipe, which is what CI and IDEs do; the critical prompt must
# then fail closed instead of hanging on /dev/tty.
run_hook() {
  ( cd "$hook_repo" && \
    PATH="$hook_bin:/usr/bin:/bin" RUN_CHECKS="$1" STUB_NODE_EXIT="$2" sh "$hook_dir/pre-push" ) \
    > "$tmp/hook.out" 2>&1 </dev/null
  status=$?
  out="$(cat "$tmp/hook.out")"
}

rm -f "$STUB_NODE_LOG" "$STUB_NPM_LOG" "$STUB_NPX_LOG"
run_hook n 0
expect_equal "$status" "0" "hook n: exit 0"
expect_contains "$out" "Skipping lint and tests." "hook n: unchanged message"
expect_file_missing "$STUB_NODE_LOG" "hook n: must not invoke node"

rm -f "$STUB_NODE_LOG" "$STUB_NPM_LOG" "$STUB_NPX_LOG"
run_hook y 0
expect_equal "$status" "0" "hook y: exit 0"
expect_file_contains "$STUB_NPX_LOG" "turbo run lint" "hook y: runs the lint gate"
expect_file_contains "$STUB_NPM_LOG" "run test-unit" "hook y: runs unit tests"
expect_file_contains "$STUB_NPM_LOG" "run test-api" "hook y: runs api tests"
expect_file_missing "$STUB_NODE_LOG" "hook y: review must not be part of the y gate"
if grep -q "run check-i18n" "$STUB_NPM_LOG"; then
  fail_case "hook y: the frozen y gate must not gain the i18n check" "$(cat "$STUB_NPM_LOG")"
else
  ok_case
fi

rm -f "$STUB_NODE_LOG" "$STUB_NPM_LOG" "$STUB_NPX_LOG"
run_hook lint 0
expect_equal "$status" "0" "hook lint: exit 0"
expect_file_contains "$STUB_NPM_LOG" "run check-i18n" "hook lint: runs the i18n check"
expect_file_contains "$STUB_NPM_LOG" "run lint-dev" "hook lint: runs lint-dev"
expect_file_missing "$STUB_NODE_LOG" "hook lint: review must not be part of the lint gate"

echo "== pre-push hook: [r]eview runs the review alone =="

rm -f "$STUB_NODE_LOG" "$STUB_NPM_LOG" "$STUB_NPX_LOG"
run_hook review 0
expect_equal "$status" "0" "hook review: clean review lets the push through"
expect_file_contains "$STUB_NODE_LOG" "tools/scripts/review.mjs" "hook review: invokes the dispatcher"
expect_file_missing "$STUB_NPM_LOG" "hook review: must not run the lint gate"
expect_file_missing "$STUB_NPX_LOG" "hook review: must not run turbo"

run_hook r 2
expect_equal "$status" "1" "hook r: critical findings abort the push when there is no TTY"
expect_contains "$out" "Critical findings reported" "hook r: the abort names the criticals"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "review dispatcher tests FAILED — the advisory layer is not trustworthy until this is green."
  exit 1
fi
echo "review dispatcher tests passed."
