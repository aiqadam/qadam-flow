# #959 — "narrow the 104-symbol re-export surface": already shipped by merged PR #965

**Status:** no code change required in this ticket's own scope.
**Investigated:** 2026-11-07, on `agent/959-qadams-framework-narrow-the-104-symbol-r`
(continuation of a branch that had already accumulated this exact work across three
earlier worker checkpoints).

## What the issue asked

Narrow `packages/qadams/framework/src/lib/shared-reexports.ts`'s 104-symbol
`@aiqadam/shared` re-export surface before `qadams-framework@1.0.0`: the census in #813
included platform-internal DTOs (tables request/record types, agent/MCP/AI-provider
types, subflow headers) used by only their own single defining core qadam, which made
them an unnecessary semver promise to every external qadam author. Scope was: identify
the single-qadam symbols, remove them from the public list, re-point the owning qadam's
imports, re-run the census, update the gate-2 `.d.ts`-diff baseline if one exists, and
note the resolution on #786 / #796.

## Finding: this branch's own prior work was merged as PR #965 on 2026-10-25

The branch (`agent/959-qadams-framework-narrow-the-104-symbol-r`) had three prior worker
checkpoints (two `claude-pro` limit stops, one `opencode-zen` limit stop). The third
checkpoint's HEAD, `d4419b42`, was opened as
[PR #965](https://github.com/aiqadam/qadam-flow/pull/965) by a fourth worker
(`opencode-go`), which fixed up the `Lint + Unit Tests` failure flagged in this issue's
comment 4 (one more commit, `9214c676`, tolerating CI scheduling jitter in an engine
test) and **merged into `main` on 2026-10-25T18:10:38Z** as squash commit `89aec70d`.

Verified directly, re-reading the current tree rather than trusting the PR's own claims:

- `git show 9214c676:packages/qadams/framework/src/lib/shared-reexports.ts` is **byte-identical**
  to `git show origin/main:packages/qadams/framework/src/lib/shared-reexports.ts` — the file's
  own header comment (lines 9–45) documents the narrowing, the 111→83 count, and the two
  constraints that bounded it (declaration-emit leaks and private/unpublished `shared`).
- `git merge-base --is-ancestor 89aec70d origin/main` succeeds: the squash-merge commit is
  on `main`'s history.
- After merging `origin/main` into this branch (no conflicts), `git diff origin/main..HEAD`
  is **empty** — this branch now carries nothing `main` doesn't already have.
- `tools/ci/sdk-api-surface.mjs` (gate 2) computes the `.d.ts` diff dynamically between a
  PR's base and head at review time; there is no committed baseline file anywhere in the
  repo for it to go stale. Confirmed by `find` — the only hits for "api-surface"/"api-diff"
  are the script itself.

Per PR #965's own body, the shipped change:

| | Before | After |
| --- | --- | --- |
| Public exported names | 111 | 83 |
| Of which the #813 import census | 104 | 76 |
| Of which auth-value types no qadam names | 7 | 7 |

28 removed (11 tables, 9 agent/MCP, 8 AI-provider config), 0 added. `core/tables` and
`community/ai` now import exactly those 28 from `@aiqadam/shared` with `import type`
(`@aiqadam/shared` added as a **devDependency**, never a runtime one); the lint ban
(`packages/qadams/eslint.config.mjs`) and the `check-qadam-shared-imports` AST backstop
still reject a value import, `require()`, dynamic `import()` or re-export from `shared`
for those two qadams and block it outright everywhere else. Two symbols did **not**
narrow — `McpProperty`/`McpPropertyType` (genuinely shared between `ai` and `mcp`) and
every subflow header/`SYNTHETIC_FLOW_RUN_IDS` (genuine single-qadam runtime values, not
narrowable the same way) — matching this issue's own "not in scope" framing for
`community/mcp` and `core/subflows`.

Seven DTOs stayed framework exports because they reach the owning qadam's **published**
`.d.ts` (`Field`, `Filter`, `PopulatedRecord` for tables; `AgentResult`, `AgentTool`,
`AgentOutputField`, `AgentFlowTool` for ai) — `tsc` erases `import type` from `.js` but
not from declaration emit, and `stagePackageForPublish`'s `assertNoPrivateDependencies`
would reject a `.d.ts` that still names the private `@aiqadam/shared` package. The
remaining single-qadam *runtime* values (enums used as values, plain constants, zod
schemas invoked in code) stayed for the same private/unpublished-`shared` reason. Both
limits are recorded as follow-ups in #965's body, not silently dropped.

## The one checklist item that was genuinely still open

Every worker through PR #965 explicitly declined the last scope item — "note in #786 /
#796 that this is resolved" — deferring it to the PR body for a maintainer to post. That
note had never actually been left on either issue. This session posted it directly:
[#786#issuecomment-6711893769](https://github.com/aiqadam/qadam-flow/issues/786#issuecomment-6711893769)
and
[#796#issuecomment-6711894177](https://github.com/aiqadam/qadam-flow/issues/796#issuecomment-6711894177).

## Why no code change was made here

There is nothing left to narrow, re-point, or re-baseline: the exact diff this issue
asked for is already on `main`, verified byte-for-byte against the file this issue names,
not just taken on the merged PR's word. Writing a new commit against
`shared-reexports.ts` now would either reintroduce the un-narrowed symbols or duplicate
work already shipped — both strictly worse than leaving the file as `main` already has
it.

## Recommendation

- Close #959 as resolved by #965.
