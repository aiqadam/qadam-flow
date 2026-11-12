# #855 — "UX: pre-release build label, update available, hold state for snapshot pins
(ADR-0004)": re-verified against the current tree — all scope is already merged

**Status:** no code change in this PR. Every item the issue and its own comments describe — including
the three items the issue's second comment explicitly deferred — is already implemented and merged on
`main`. This doc records the evidence so the issue can be closed without anyone re-deriving this.

**Investigated:** 2026-11-12, on `agent/855-ux-pre-release-build-label-update-availa` (branch at `main`'s
current head, `19b59634`).

## What the issue asked for

1. A "pre-release build" label on snapshot-pinned steps in the builder, in MCP (`ap_flow_structure`,
   `ap_validate_flow`) and in runs.
2. "Update available" pointing at the release once the line is released.
3. The hold state from #854.

## What the issue's own comment (2026-10-10) said was done vs. deferred

The issue's second comment records items 1–3 as merged via #884 (`4ac14f03`), #886 (`3f8d7998`) and
#887 (`f00a855e`) — builder for all three, plus MCP for item 1 only — and defers three things:

- **Runs surface** — "no surface in a run displays a step's pinned version today... inventing one is a
  separate concern."
- **MCP + runs surfaces of the hold, and the `exportedUnresolvedPin` / agent-tool "update this step"
  marking** — attributed to "a different #808 slice."
- **A project-level revert** — "revert stays platform-admin."

## Finding: two of the three deferred items were done anyway, after that comment, under #855 itself

`#884`, `#886` and `#887` are all ancestors of this branch's `HEAD` (`git merge-base --is-ancestor`
confirms it for each), so they are not in question. Two PRs that merged **after** the comment above
close the remaining #855 scope:

- **#893**, "feat(web): run-view pre-release labels and Update this step mark (ADR-0004, #855)", merged
  2026-10-11 (`ba52462b`). Its own body: "Closes the web leftovers of #855." It adds the pre-release /
  update-available / held labels to the run step detail view
  (`packages/web/src/app/builder/run-details/flow-step-input-output.tsx:52,353`, reusing the same
  `UpdateAvailableLabel`/`HeldStepLabel`/`PreReleaseBuildLabel` components the builder uses) and a new
  "Update this step" mark for a step carrying `settings.exportedUnresolvedPin`
  (`packages/web/src/app/builder/step-settings/update-this-step-label.tsx`), with the agent-tool-origin
  rule the issue's first comment specified (the tool's own pin decides, not the agent step's
  `qadamVersion`). This covers both "Runs surface" and the **web/builder** half of the
  `exportedUnresolvedPin` marking the second comment attributed to #808.
- **#968**, "feat(mcp): report the snapshot follow hold in ap_flow_structure and ap_validate_flow",
  merged 2026-10-25, closes #854 — but its content is exactly the "MCP ... surfaces of the hold" item
  #855's comment deferred: `ap_flow_structure` marks a held step `[FOLLOW HELD]` and carries
  `followHeld { fromVersion, toVersion, revertedAt }`
  (`packages/server/api/src/app/mcp/tools/ap-flow-structure.ts:61,125,155-158`), and `ap_validate_flow`
  reports the same hold as an informational `follow_hold` note
  (`packages/server/api/src/app/mcp/tools/ap-validate-flow.ts:299-335`). Both read the project-scoped
  `GET /v1/qadam-pin-moves/held` #887 added
  (`packages/server/api/src/app/qadams/pin-moves/qadam-pin-move.controller.ts:21`).

So of the three deferred items, only two things remain genuinely out of #855's scope:

- **The MCP surface of the `exportedUnresolvedPin` / agent-tool "update this step" marking.** Not found
  anywhere under `packages/server/api/src/app/mcp` (`grep -rn exportedUnresolvedPin` returns nothing
  there). `gh issue view 808` confirms it is still open and its own title names exactly this: `"update
  this step" UX (ADR-0003)`. Correctly out of scope for #855.
- **A project-level revert.** Not attempted here; the comment's own reasoning (revert stays
  platform-admin, the hold read is project-scoped) still holds and nothing in the codebase contradicts
  it. No open issue was found that explicitly tracks it, but inventing a platform-admin-vs-project-level
  authorization decision without the maintainer who made the original call is exactly the kind of
  judgment call `.agents/rules/read-the-ticket.md` says not to make unilaterally.

## Verified present on the current tree

- Builder: `packages/web/src/app/builder/step-settings/pre-release-build-label.tsx`,
  `update-available-label.tsx`, `held-step-label.tsx`, `update-this-step-label.tsx`, all wired into
  `step-settings/index.tsx`.
- Run view: the same three read-only labels plus the update-this-step mark, wired into
  `run-details/flow-step-input-output.tsx`.
- MCP: `ap-flow-structure.ts` and `ap-validate-flow.ts` both report pre-release-build and follow-hold
  (`preReleaseBuildLabel`, `followHoldLabel`, `pre_release_build` / `follow_hold` validation
  categories).
- Server: `GET /v1/qadam-pin-moves/held` (`qadam-pin-move.controller.ts`), project-scoped per
  `.agents/rules/data-isolation.md`.

## Recommendation

Close #855. Its own stated scope (items 1–3) and the two "runs surface" / "MCP hold surface" items its
comment deferred are all merged. The two things still open — MCP's `exportedUnresolvedPin` marking and
a project-level revert — belong to #808 and to a separate, not-yet-filed authorization decision
respectively; neither is #855's own text. A comment to that effect, with the PR numbers above, was
posted on the issue as part of this session rather than silently closing it.
