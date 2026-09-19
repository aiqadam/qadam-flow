# Skills are mandatory, not suggestions

A skill under `.agents/skills/` is this repo's settled answer to a recurring task. If your
work matches a trigger in the table below, **open that skill's `SKILL.md` before you write
the first line of code**, and follow it. Not "consider it" — open it.

Three rules, no exceptions:

1. **Trigger matched → skill used.** A skill does not wait to be invoked by name. The user
   typing `/qadam-builder` is one way in; recognising that you are building a qadam is the
   other, and it is the one that matters.
2. **Deviating is allowed. Deviating silently is not.** If the skill is wrong for this task,
   say so — one sentence, in your reply and in the PR body, with the reason. If a skill is
   wrong twice, that is a bug report: fix the skill in the same PR rather than routing
   around it again.
3. **The skill beats your memory.** Where a skill and your recollection of this codebase
   disagree, the skill is the convention and your recollection is a guess. Where a skill
   and the code disagree, the code wins and the skill gets fixed.

## Trigger registry

Every skill in the repo, with the condition that makes it mandatory. CI
(`npm run check-agent-docs`) fails if a skill exists that is not listed here, or if a row
here names a skill that does not exist — so this table cannot quietly go stale.

| Skill | Use it when | Main scope |
| --- | --- | --- |
| `add-endpoint` | Adding or reshaping a Fastify route / HTTP handler | `packages/server/api` |
| `add-entity` | Creating a TypeORM `EntitySchema` — i.e. a new table | `packages/server/api` |
| `add-feature` | The work spans two or more of shared / server / worker / web | monorepo |
| `agent-browser` | Driving a real browser: open a page, fill a form, click, screenshot, scrape | any |
| `db-migration` | Any schema change at all: table, column, index, backfill | `packages/server/api` |
| `design` | Any user-visible surface: UI, colour, logo, spacing, brand, docs styling | `packages/web`, `docs/` |
| `grill-me` | The user asks to be interviewed or stress-tested on a plan | — |
| `local-docker-deploy` | Running the stack locally in Docker, or touching `run.sh` / the compose files | repo root |
| `mcp-builder` | Building or changing an MCP server | `packages/server/api/src/app/mcp` |
| `mintlify` | Writing or restructuring anything under `docs/` | `docs/` |
| `playwright-e2e-testing` | Adding, debugging or restructuring an E2E spec | `packages/tests-e2e` |
| `qadam-builder` | Creating or changing a qadam — its actions, triggers, props or auth | `packages/qadams` |
| `ubiquitous-language` | Before proposing ANY new feature, and when adding or renaming a domain term | `.agents/features` |

Two or more triggers can match at once; that is normal, not a conflict. A new
project-scoped table plus its UI is `add-feature` **and** `add-entity` **and**
`db-migration` **and** `design` — read all four, in that order, and let the broadest one
sequence the work.

## Adding or changing a skill

- One job, one skill. If an existing skill covers the job badly, extend it. A second
  skill for the same job is how a repo ends up with two contradictory playbooks and no
  way to tell which is canon.
- `SKILL.md` needs YAML frontmatter with `name` (exactly the directory name) and a
  `description` that states **what it does and when to use it**. The description is the
  only thing a harness sees when deciding whether to load the skill — a description that
  just repeats the title means the skill will never fire.
- Add a row to the registry above in the same commit.
- Supporting material (`README.md`, `props-patterns.md`, …) lives beside `SKILL.md` in the
  skill's own directory and is linked from it.
- Run `npm run check-agent-docs` before pushing. CI runs it too.
- Adding, deleting or repurposing a skill is a user decision, not an agent decision — ask
  first, the same as for `.agents/agents/*.md` charters.
