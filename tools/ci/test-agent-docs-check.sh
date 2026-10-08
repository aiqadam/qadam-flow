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
# the three registries, the five mirrors and an empty ADR index.
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

  mkdir -p "$root/adr"
  cat > "$root/adr/README.md" <<'EOF'
# ADRs

## Index

| ADR | Title | Status |
| --- | --- | --- |
| — | No ADRs yet | — |
EOF
  echo '# template' > "$root/adr/TEMPLATE.md"

  ln -s ../.agents/skills "$root/.claude/skills"
  ln -s ../.agents/agents "$root/.claude/agents"
  ln -s ../.agents/rules "$root/.claude/rules"
  ln -s ../.agents/skills "$root/.cursor/skills"
  ln -s ../.agents/rules "$root/.cursor/rules"
}

write_adr() {
  # $1 = file name, $2 = status, $3 = deciders (YAML), $4 = superseded-by, $5 = supersedes
  cat > "$root/adr/$1" <<EOF
---
status: $2            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08
deciders: ${3:-[]}
issue: "#1"
supersedes: ${5:-null}
superseded-by: ${4:-null}
---

# Demo decision
EOF
}

list_adr() {
  # $1 = number, $2 = status. The real index drops the placeholder row once an ADR exists.
  grep -v 'No ADRs yet' "$root/adr/README.md" > "$root/index.tmp" && mv "$root/index.tmp" "$root/adr/README.md"
  printf '| [`%s`](%s-demo.md) | Demo decision | `%s` |\n' "$1" "$1" "$2" >> "$root/adr/README.md"
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

echo "== a listed ADR in a valid state passes =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]'
list_adr 0001 accepted
run_check
expect_status 0 "a decided, indexed ADR is the normal case"

echo "== an ADR missing from the index fails =="
new_root
write_adr 0001-demo.md proposed
run_check
expect_status 1 "an unindexed ADR is a decision nobody is pointed at"
expect_contains 'ADR "0001" exists on disk but is missing from adr/README.md' "names the ADR and the index"

echo "== an index row with no ADR behind it fails =="
new_root
list_adr 0002 proposed
run_check
expect_status 1 "a phantom row points at a decision that is not there"
expect_contains 'lists ADR "0002"' "names the phantom"

echo "== an index row with the wrong status fails =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]'
list_adr 0001 proposed
run_check
expect_status 1 "the index must not misreport where a decision stands"
expect_contains 'shows status "proposed", but the file says `accepted`' "names both sides of the mismatch"

echo "== an index row linking to the wrong file fails =="
new_root
write_adr 0001-demo.md proposed
list_adr 0001 proposed
sed -i.bak 's/(0001-demo.md)/(0001-renamed.md)/' "$root/adr/README.md" && rm "$root/adr/README.md.bak"
run_check
expect_status 1 "a stale link in the index is rot the number check cannot see"
expect_contains 'links to "0001-renamed.md", but the file is 0001-demo.md' "names both sides of the mismatch"

echo "== a quoted status with a trailing comment is read as the status =="
new_root
write_adr 0001-demo.md '"proposed"'
list_adr 0001 proposed
run_check
expect_status 0 "the template's comments must not change what a value means"

echo "== supporting files beside the ADRs are not mistaken for ADRs =="
new_root
mkdir -p "$root/adr/assets"
echo 'png' > "$root/adr/assets/diagram.png"
echo 'png' > "$root/adr/0001-diagram.png"
run_check
expect_status 0 "an ADR may link a diagram kept next to it"

echo "== an unknown ADR status fails =="
new_root
write_adr 0001-demo.md approved
list_adr 0001 approved
run_check
expect_status 1 "only the documented lifecycle states are valid"
expect_contains 'status "approved" is not one of' "names the bad status"

echo "== an accepted ADR with no deciders fails =="
new_root
write_adr 0001-demo.md accepted
list_adr 0001 accepted
run_check
expect_status 1 "a decision must record who made it"
expect_contains '"deciders" is empty' "says which field is missing"

echo "== a superseded ADR that names no successor fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]'
list_adr 0001 superseded
run_check
expect_status 1 "a superseded decision must point at its replacement"
expect_contains '"superseded-by" names no ADR' "says which field is missing"

echo "== a superseded ADR that points at its successor passes =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md accepted '[binalirustamov]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 accepted
run_check
expect_status 0 "superseding is the normal way a decision changes"

echo "== a superseded ADR that points at a missing ADR fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0009"'
list_adr 0001 superseded
run_check
expect_status 1 "a successor that does not exist leaves the decision with no current answer"
expect_contains 'names ADR 0009, which does not exist' "names the missing successor"

echo "== an ADR superseded by itself fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0001"'
list_adr 0001 superseded
run_check
expect_status 1 "a decision cannot replace itself"
expect_contains '"superseded-by" names the ADR itself' "says what is wrong"

echo "== an ADR superseded by one that is not accepted yet fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md proposed '[]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 proposed
run_check
expect_status 1 "the old decision stands until the new one is accepted"
expect_contains 'which is proposed' "says why"

echo "== a successor that does not point back fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md accepted '[binalirustamov]'
list_adr 0001 superseded
list_adr 0002 accepted
run_check
expect_status 1 "supersession is recorded on both sides"
expect_contains 'whose "supersedes" does not name 0001' "names both ADRs"

echo "== deciders written as an empty list with a space fails =="
new_root
write_adr 0001-demo.md accepted '[ ]'
list_adr 0001 accepted
run_check
expect_status 1 "[ ] names nobody"
expect_contains '"deciders" is empty' "says which field is empty"

echo "== an ADR listed twice in the index fails =="
new_root
write_adr 0001-demo.md proposed
list_adr 0001 proposed
list_adr 0001 proposed
run_check
expect_status 1 "two rows for one decision will drift apart"
expect_contains 'ADR 0001 has more than one row' "names the duplicate"

echo "== the placeholder row left beside a real ADR fails =="
new_root
write_adr 0001-demo.md proposed
printf '| [`0001`](0001-demo.md) | Demo decision | `proposed` |\n' >> "$root/adr/README.md"
run_check
expect_status 1 "the first real ADR PR is where this is forgotten"
expect_contains 'row without an ADR number' "points at the placeholder"

echo "== a chain of supersessions passes =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md superseded '[binalirustamov]' '"0003"' '"0001"'
write_adr 0003-demo.md accepted '[binalirustamov]' null '"0002"'
list_adr 0001 superseded
list_adr 0002 superseded
list_adr 0003 accepted
run_check
expect_status 0 "a decision replaced twice is normal, and the middle one must not turn CI red"

echo "== a successor that was later deprecated passes =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md deprecated '[binalirustamov]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 deprecated
run_check
expect_status 0 "deprecating the successor does not un-replace the original"

echo "== one ADR replacing two passes =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0003"'
write_adr 0002-demo.md superseded '[binalirustamov]' '"0003"'
write_adr 0003-demo.md accepted '[binalirustamov]' null '["0001", "0002"]'
list_adr 0001 superseded
list_adr 0002 superseded
list_adr 0003 accepted
run_check
expect_status 0 "consolidating two decisions into one is a real case"

echo "== an accepted ADR whose predecessor was never retired fails =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]'
write_adr 0002-demo.md accepted '[binalirustamov]' null '"0001"'
list_adr 0001 accepted
list_adr 0002 accepted
run_check
expect_status 1 "two contradictory decisions must not both be binding"
expect_contains 'supersedes ADR 0001, which is still accepted' "names the predecessor and its status"

echo "== a proposed ADR may name a predecessor that is still accepted =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]'
write_adr 0002-demo.md proposed '[]' null '"0001"'
list_adr 0001 accepted
list_adr 0002 proposed
run_check
expect_status 0 "the old decision stands until the new one is accepted"

echo "== supersedes naming a missing ADR fails =="
new_root
write_adr 0001-demo.md proposed '[]' null '"0009"'
list_adr 0001 proposed
run_check
expect_status 1 "a predecessor that does not exist is a typo"
expect_contains '"supersedes" names ADR 0009, which does not exist' "names the missing ADR"

echo "== deciders written as a list of one empty string fails =="
new_root
write_adr 0001-demo.md accepted '[""]'
list_adr 0001 accepted
run_check
expect_status 1 "[\"\"] names nobody"
expect_contains '"deciders" is empty' "says which field is empty"

echo "== a renamed header row is still a header =="
new_root
write_adr 0001-demo.md proposed
list_adr 0001 proposed
sed -i.bak 's/^| ADR | Title | Status |$/| Number | Title | Status |/' "$root/adr/README.md" && rm "$root/adr/README.md.bak"
run_check
expect_status 0 "the header is whatever sits above the separator"

echo "== a table under a later heading is not read as the index =="
new_root
printf '\n## Elsewhere\n\n| ADR | Note |\n| --- | --- |\n| [`0009`](0009-x.md) | `proposed` |\n' >> "$root/adr/README.md"
run_check
expect_status 0 "only the first table under the index heading is the index"

echo "== a successor with an invalid status is reported, not crashed on =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md acepted '[binalirustamov]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 acepted
run_check
expect_status 1 "the typo is the finding"
expect_contains 'status "acepted" is not one of' "names the typo"
expect_not_contains 'TypeError' "a finding, not a stack trace"

echo "== a predecessor retired in favour of a different ADR fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0003"'
write_adr 0002-demo.md accepted '[binalirustamov]' null '"0001"'
write_adr 0003-demo.md accepted '[binalirustamov]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 accepted
list_adr 0003 accepted
run_check
expect_status 1 "two ADRs cannot both have replaced the same one"
expect_contains 'whose "superseded-by" names 0003 instead' "names the ADR the predecessor agrees with"

echo "== a supersession cycle fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"' '"0002"'
write_adr 0002-demo.md superseded '[binalirustamov]' '"0001"' '"0001"'
list_adr 0001 superseded
list_adr 0002 superseded
run_check
expect_status 1 "a loop leaves no decision standing"
expect_contains 'leads back to this ADR' "says what is wrong"

echo "== an ADR that supersedes itself fails =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]' null '"0001"'
list_adr 0001 accepted
run_check
expect_status 1 "a decision cannot replace itself"
expect_contains '"supersedes" names the ADR itself' "says what is wrong"

echo "== an ADR superseded by a rejected one fails =="
new_root
write_adr 0001-demo.md superseded '[binalirustamov]' '"0002"'
write_adr 0002-demo.md rejected '[binalirustamov]' null '"0001"'
list_adr 0001 superseded
list_adr 0002 rejected
run_check
expect_status 1 "a proposal that lost replaced nothing"
expect_contains 'which is rejected' "says why"

echo "== reopening a rejected ADR passes without flipping it =="
new_root
write_adr 0001-demo.md rejected '[binalirustamov]'
write_adr 0002-demo.md accepted '[binalirustamov]' null '"0001"'
list_adr 0001 rejected
list_adr 0002 accepted
run_check
expect_status 0 "the rejected record stays as it was"

echo "== superseded-by on an ADR that is not superseded fails =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]' '"0002"'
write_adr 0002-demo.md accepted '[binalirustamov]'
list_adr 0001 accepted
list_adr 0002 accepted
run_check
expect_status 1 "the two fields must agree"
expect_contains '"superseded-by" is set but the status is "accepted"' "names the status"

echo "== an index heading with no table does not borrow a later one =="
new_root
write_adr 0001-demo.md accepted '[binalirustamov]'
cat > "$root/adr/README.md" <<'EOF'
# ADRs

## Index

Nothing here yet.

## Elsewhere

| ADR | Title | Status |
| --- | --- | --- |
| [`0001`](0001-demo.md) | Demo decision | `proposed` |
EOF
run_check
expect_status 1 "an index with no table is a finding"
expect_contains 'no table found under a heading containing "Index"' "says the index is missing"
expect_not_contains 'shows status' "a table under another heading is not read as the index"

echo "== a misnamed file under adr/ fails =="
new_root
echo 'notes' > "$root/adr/notes.md"
run_check
expect_status 1 "stray files in adr/ escape the index"
expect_contains 'adr/notes.md: not an ADR file name' "names the file"

echo "== two ADRs with the same number fail =="
new_root
write_adr 0001-demo.md proposed
write_adr 0001-other.md proposed
list_adr 0001 proposed
run_check
expect_status 1 "numbers are never reused"
expect_contains 'ADR number 0001 is already taken' "names the duplicate"

echo "== an adr/ directory that moved away is never reported as clean =="
new_root
rm -rf "$root/adr"
run_check
expect_status 1 "scanning no ADR directory must fail loudly"
expect_contains 'adr/ does not exist' "a deliberate finding, not a crash"
expect_not_contains "OK —" "a missing ADR directory is never a pass"

echo
echo "passed: ${pass}   failed: ${fail}"
if [ "$fail" -ne 0 ]; then
  echo "agent-docs checker tests FAILED."
  exit 1
fi
echo "agent-docs checker tests passed."
