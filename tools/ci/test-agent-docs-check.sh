#!/usr/bin/env bash
#
# Fixture tests for the agent-docs wiring gate (tools/ci/check-agent-docs.mjs).
#
# The gate's whole value is that it fails on drift nobody would otherwise notice — a skill
# absent from the trigger registry, a charter with no trigger in its description, a mirror
# symlink replaced by a real directory. A gate like that is worth exactly as much as its
# reject cases, so every one of them is pinned here, alongside the accept cases that must
# stay quiet.
#
# Pure node + bash, no workspace dependencies — runs before any install in
# .github/workflows/_verify.yml, so a docs-only PR still gets it.
#
#   tools/ci/test-agent-docs-check.sh

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="${here}/check-agent-docs.mjs"

pass=0
fail=0
root=""

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

write_skill() {
  # $1 = skill name, $2 = description
  mkdir -p "$root/.agents/skills/$1"
  cat > "$root/.agents/skills/$1/SKILL.md" <<EOF
---
name: $1
description: $2
---

# $1
EOF
}

write_agent() {
  # $1 = agent name, $2 = description
  cat > "$root/.agents/agents/$1.md" <<EOF
---
name: $1
description: $2
---

# $1
EOF
}

# A minimal but structurally faithful tree: two skills, one charter, two rules, one deep dive,
# the three registries and the five mirrors.
new_root() {
  cleanup
  root="$(mktemp -d)"
  mkdir -p "$root/.agents/agents" "$root/.agents/rules" "$root/.agents/docs" "$root/.claude" "$root/.cursor"

  write_skill demo-skill "Demo workflow for the fixture tree. Use when the fixture calls for a skill that triggers."
  write_skill other-skill "Second demo workflow for the fixture tree. Use when a second skill is needed."
  write_agent demo-agent "Demo reviewer for the fixture tree. Use before you report a fixture change complete."

  cat > "$root/.agents/rules/skill-usage.md" <<'EOF'
# Skills are mandatory

## Trigger registry

| Skill | Use it when |
| --- | --- |
| `demo-skill` | The fixture calls for it |
| `other-skill` | The fixture calls for a second one |
EOF

  cat > "$root/.agents/rules/agent-delegation.md" <<'EOF'
# Subagents

## When: the delegation matrix

| Agent | Delegate when | Binding |
| --- | --- | --- |
| `demo-agent` | Before reporting complete | Mandatory |
EOF

  echo 'A deep dive.' > "$root/.agents/docs/deep-dive.md"

  mkdir -p "$root/packages/demo"
  cat > "$root/packages/demo/AGENTS.md" <<'EOF'
# Demo package

Use the `demo-skill` skill, and delegate to the `demo-agent` agent.
The `demo-agent` reviewer is mandatory before reporting complete.
EOF

  cat > "$root/AGENTS.md" <<'EOF'
# Root

### Every rule, and what it stops you doing

| Rule | What it stops you doing |
| --- | --- |
| [`agent-delegation.md`](.agents/rules/agent-delegation.md) | Skipping a review |
| [`skill-usage.md`](.agents/rules/skill-usage.md) | Skipping a skill |

See [deep dive](.agents/docs/deep-dive.md).
EOF

  ln -s ../.agents/skills "$root/.claude/skills"
  ln -s ../.agents/agents "$root/.claude/agents"
  ln -s ../.agents/rules "$root/.claude/rules"
  ln -s ../.agents/skills "$root/.cursor/skills"
  ln -s ../.agents/rules "$root/.cursor/rules"
}

run_check() {
  out="$(node "$checker" --root "$root" 2>&1)"
  status=$?
}

expect_status() {
  if [ "$status" -eq "$1" ]; then
    ok
  else
    bad "expected exit $1, got $status — $2"$'\n'"$out"
  fi
}

expect_contains() {
  case "$out" in
    *"$1"*) ok ;;
    *) bad "expected output to contain '$1' — $2"$'\n'"$out" ;;
  esac
}

expect_not_contains() {
  case "$out" in
    *"$1"*) bad "expected output NOT to contain '$1' — $2"$'\n'"$out" ;;
    *) ok ;;
  esac
}

echo "== a fully wired tree passes =="
new_root
run_check
expect_status 0 "the baseline fixture is the shape the repo is in"
expect_contains "OK —" "a clean run says so"

echo "== a skill missing from the trigger registry fails =="
new_root
write_skill orphan-skill "An unregistered workflow. Use when nothing points at it."
run_check
expect_status 1 "an unlisted skill is the exact drift this gate exists for"
expect_contains 'skill "orphan-skill" exists on disk but is missing' "names the skill and the registry"

echo "== a registry row with no skill behind it fails =="
new_root
printf '| `ghost-skill` | Nothing |\n' >> "$root/.agents/rules/skill-usage.md"
run_check
expect_status 1 "a phantom row sends agents to a file that is not there"
expect_contains 'lists skill "ghost-skill"' "names the phantom"

echo "== a SKILL.md with no frontmatter fails =="
new_root
printf '# No frontmatter here\n' > "$root/.agents/skills/demo-skill/SKILL.md"
run_check
expect_status 1 "without frontmatter the harness derives a description from the H1"
expect_contains "no YAML frontmatter" "says what is missing"

echo "== a frontmatter name that disagrees with the directory fails =="
new_root
write_skill demo-skill "Demo workflow for the fixture tree. Use when the fixture calls for a skill that triggers."
sed -i.bak 's/^name: demo-skill$/name: something-else/' "$root/.agents/skills/demo-skill/SKILL.md"
run_check
expect_status 1 "the registries key on the path"
expect_contains 'expected "demo-skill"' "names both sides of the mismatch"

echo "== a description with no trigger fails =="
new_root
write_skill demo-skill "An end-to-end testing framework with cross-browser automation and a test runner."
run_check
expect_status 1 "a description that only names the topic cannot be acted on"
expect_contains "states no trigger" "says what is wrong with it"

echo "== a description too short to say anything fails =="
new_root
write_skill demo-skill "Use when."
run_check
expect_status 1 "a derived H1 is typically this short"
expect_contains "characters; at least" "reports the actual length"

echo "== a description carrying the upstream product name fails =="
new_root
write_skill demo-skill "Demo workflow for Activepieces. Use when the fixture calls for it and the naming is wrong."
run_check
expect_status 1 "the product is Qadam Flow"
expect_contains "The product is Qadam Flow" "says so plainly"

echo "== a charter missing from the delegation matrix fails =="
new_root
write_agent orphan-agent "An unregistered reviewer. Use before nobody ever calls it."
run_check
expect_status 1 "a charter nobody is told to invoke is documentation, not a reviewer"
expect_contains 'agent "orphan-agent" exists on disk but is missing' "names the charter"

echo "== a rule missing from the AGENTS.md index fails =="
new_root
echo 'Never do the thing.' > "$root/.agents/rules/unlisted-rule.md"
run_check
expect_status 1 "every rule is in force every session, so every rule is indexed"
expect_contains 'rule "unlisted-rule.md" exists on disk but is missing' "names the rule"

echo "== a deep dive nothing links to fails =="
new_root
echo 'Orphaned.' > "$root/.agents/docs/unlinked.md"
run_check
expect_status 1 "an unlinked deep dive is never read"
expect_contains "not linked from AGENTS.md" "says where the link belongs"

echo "== a mirror replaced by a real directory fails =="
new_root
rm "$root/.claude/skills"
mkdir -p "$root/.claude/skills/copied-skill"
run_check
expect_status 1 "a real directory there is a second copy that will drift"
expect_contains "not a symlink" "names the failure mode"

echo "== a missing mirror fails =="
new_root
rm "$root/.cursor/rules"
run_check
expect_status 1 "the mirror is how the harness auto-discovers the rules"
expect_contains ".cursor/rules: missing" "names the mirror"

echo "== a mirror pointing at the wrong target fails =="
new_root
rm "$root/.claude/agents"
ln -s ../.agents/rules "$root/.claude/agents"
run_check
expect_status 1 "a mirror aimed at the wrong directory serves the wrong content"
expect_contains ".claude/agents: points at" "names both targets"

echo "== a loose file directly under .agents/skills fails =="
new_root
echo 'stray' > "$root/.agents/skills/stray.md"
run_check
expect_status 1 "a skill is a directory containing SKILL.md"
expect_contains "not a loose file" "says what the shape should be"

echo "== a skills directory that moved away is never reported as clean =="
new_root
rm -rf "$root/.agents/skills"
run_check
expect_status 1 "scanning nothing must fail loudly, not pass forever"
expect_not_contains "OK —" "an empty tree is never a pass"

echo "== an unparseable registry fails rather than passing vacuously =="
new_root
printf '# Skills are mandatory\n\nNo table here at all.\n' > "$root/.agents/rules/skill-usage.md"
run_check
expect_status 1 "a registry the gate cannot read proves nothing"
expect_contains "cannot be parsed" "says the registry is the problem"

echo "== a per-package AGENTS.md routing to a skill that does not exist fails =="
new_root
sed -i.bak 's/`demo-skill` skill/`gone-skill` skill/' "$root/packages/demo/AGENTS.md"
run_check
expect_status 1 "per-package routing tables are the point of the change; they cannot sit outside the gate"
expect_contains 'packages/demo/AGENTS.md' "names the file that went stale"
expect_contains 'routes to skill "gone-skill"' "names the dangling reference"

echo "== a per-package AGENTS.md routing to a charter that does not exist fails =="
new_root
sed -i.bak 's/`demo-agent` agent/`gone-agent` agent/' "$root/packages/demo/AGENTS.md"
run_check
expect_status 1 "the same drift applies to charters"
expect_contains 'routes to agent "gone-agent"' "names the dangling reference"

echo "== a lowercase-kebab symbol in backticks is not mistaken for a routing reference =="
new_root
printf '\nThe `flow-version` helper and the `demo-skill` skill are different things.\n' >> "$root/packages/demo/AGENTS.md"
run_check
expect_status 0 "a bare backticked token is a symbol; only the skill/agent/reviewer/path shapes are references"

echo "== a per-package AGENTS.md naming a charter as a reviewer is covered too =="
new_root
sed -i.bak 's/`demo-agent` reviewer/`gone-reviewer` reviewer/' "$root/packages/demo/AGENTS.md"
run_check
expect_status 1 "the two mandatory charters are written as reviewers, not as agents"
expect_contains 'routes to agent "gone-reviewer"' "the reviewer spelling resolves to a charter"

echo "== an empty deep-dive directory is never reported as clean =="
new_root
rm "$root/.agents/docs/deep-dive.md"
run_check
expect_status 1 "empty is the same vacuous pass as missing"
expect_contains "contains no deep dives" "says the directory is empty"

echo "== a deep-dive directory that moved away is never reported as clean =="
new_root
rm -rf "$root/.agents/docs"
run_check
expect_status 1 "a check that silently stops existing is worse than no check"
expect_contains ".agents/docs/ does not exist" "says the directory is gone"

echo "== a skill directory with no SKILL.md fails =="
new_root
rm "$root/.agents/skills/other-skill/SKILL.md"
run_check
expect_status 1 "a directory under .agents/skills without SKILL.md is not a skill"
expect_contains "must carry a SKILL.md" "says what is missing"

echo "== frontmatter with no name fails =="
new_root
cat > "$root/.agents/skills/demo-skill/SKILL.md" <<'EOF'
---
description: Demo workflow for the fixture tree. Use when the fixture calls for a skill that triggers.
---

# demo-skill
EOF
run_check
expect_status 1 "the registries key on the name"
expect_contains 'frontmatter has no "name"' "says which field is missing"

echo "== frontmatter with no description fails =="
new_root
cat > "$root/.agents/skills/demo-skill/SKILL.md" <<'EOF'
---
name: demo-skill
---

# demo-skill
EOF
run_check
expect_status 1 "a skill with no description can never be selected"
expect_contains 'frontmatter has no "description"' "says which field is missing"

echo "== a charters directory that moved away is never reported as clean =="
new_root
rm -rf "$root/.agents/agents"
run_check
expect_status 1 "scanning no charters must fail loudly"
expect_not_contains "OK —" "an empty charter set is never a pass"

echo "== a missing root AGENTS.md fails =="
new_root
rm "$root/AGENTS.md"
run_check
expect_status 1 "AGENTS.md is the entry point every harness reads first"
expect_not_contains "OK —" "a tree with no root doc is never a pass"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "agent-docs checker tests FAILED."
  exit 1
fi
echo "agent-docs checker tests passed."
