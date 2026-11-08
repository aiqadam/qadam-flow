# #779 — this branch's work is already shipped (#966) or pending in an open PR (#1034)

**Status:** no code change made in this PR; it is a merge up to `main` plus this note.
**Investigated:** 2026-11-08, on `agent/779-resolve-qadams-by-name-version-from-the`
(a fleet re-run of a branch stopped by three prior subscription-limit/failure checkpoints).

## What this branch held

Six commits, built up across several fleet workers between 2026-10-25 and 2026-11-07:

1. `d29ef354` — the API's `qadamMetadataService` and the framework-major census resolve an
   official exact pin from the qadam version store before the registry/bundled build.
2. `19614e4f` — a stored pin above this release's floors, or unreadable, fails with the pin
   named instead of falling through to a different build.
3. `bac3c9af` — an unreadable stored pin is reported as unknown (not a miss); store reads
   are cached and bounded.
4. `21298f06` — tests for the above three.
5. `9ed1d20f` — `frameworkCensusMarking.unsupportedPins` also walks an agent step's PIECE
   tools, not just the step's own pin; `ap_validate_flow` / `ap_flow_structure` mark a
   dead-framework-version tool the same way they mark a step.
6. `8a428437` — `findExactVersionFor` was returning bare `undefined` (a miss) instead of
   `{ unusable: true }` for a stored version outside this release's support floors, letting
   the engine's own fallback silently substitute a different build even though the store
   still held, and the engine would still run, the named pin.

## What had happened to it while this branch sat

`main` moved 69 commits ahead between this branch's last push and this session. Two of those
commits are PRs that already carry this exact work forward:

| This branch's commits | Landed as | State |
| --- | --- | --- |
| 1–4 (`d29ef354`..`21298f06`) | [#966](https://github.com/aiqadam/qadam-flow/pull/966), squash-merged 2026-10-25 | **Merged.** The #779-specific source and test files it added (`stored-qadam-metadata.ts` and its test, the store-metadata test fixtures and tests) are identical on `origin/main` today. A few files it also touched (`app.ts`, `GLOSSARY.md`, `framework-census.md`, `qadam-version-catalogue.md`, `qadam-version-store.mdx`) differ from this branch's copy of them only because `main` kept moving afterwards (#806, #963, #967, #1033 and others touched the same files later) — the #779 content itself landed, it just isn't the only thing in those files anymore. |
| 5–6 (`9ed1d20f`, `8a428437`) | [#1034](https://github.com/aiqadam/qadam-flow/pull/1034), opened 2026-11-08 | **Open, mergeable.** Its own description explains why: "this task for #779 was re-run on its old branch after #966 had squash-merged. A later worker rebased that branch, and the fleet's checkpoint sync refuses a rewritten branch" (tracked in `binalirustamov/virtual-employee#228`). #1034 cherry-picked these two commits onto current `main` and hand-resolved the conflicts against what main gained meanwhile — #854's follow-hold feature in `ap-flow-structure.ts` / `ap-validate-flow.ts`, mainly. |

`git merge-tree --write-tree origin/main 8a428437` confirmed this branch's six commits, applied
as-is on top of current `main`, produce real conflicts in `ap-flow-structure.ts`,
`ap-validate-flow.ts`, `qadam-metadata-service.ts`, two test files, two `.agents/features/*.md`
docs and the changeset — i.e. merging this branch as-is would not be a clean fast-forward and
would need the same conflict resolution #1034 already did. (`framework-census-marking.ts` is
not in that list — it auto-merges without conflict, which is exactly why this branch's own
merge needed the follow-up fixup commit below: an auto-merge is not the same as "no change
needed".)

## What this PR does instead

Rather than redo #1034's conflict resolution on a second branch — which would leave two open
PRs making the identical change, doubling the mandatory `code-quality` / `app-sec` review cost
for no second outcome — this PR merges `origin/main` into this branch and resolves every
conflict (and the few auto-merged leftovers, which left `frameworkCensusMarking.unsupportedPins`
accepting an `agentTools` param its reverted callers no longer passed) by taking `main`'s side.
`git diff origin/main HEAD` is now empty except for this note. This keeps the branch's prior
commits intact — the fleet checkpoint-sync fragility #1034 describes is about *rewriting*
this branch's history, and a merge commit does not rewrite anything — while making the PR a
true no-op against `main` that cannot regress it or race #1034.

## What is genuinely still open for #779 (not in this PR's scope)

`main`'s own `.agents/features/pieces.md` ("Qadam Version Store (#805)" section) already
tracks this precisely, independent of anything in this investigation:

> **Left to other tickets:** the rest of #779 (isolate mounts, custom qadams, removing
> `qadamPinFallback` once #808's move covers every path), fetching and the legacy install
> path (#806, ...), GC and registry config (#478), image seed contents (#807), the rest of
> the unavailable-version fallback (#808: ...).

Confirmed directly in code: `packages/server/engine/src/lib/helper/qadam-version-store-resolver.ts`'s
module comment says the worker hands the engine the store's root "the forked execution modes
only, #779", and `packages/server/worker/src/lib/cache/qadams/qadam-version-store-root.ts`'s
own comment and its `isUsedBy` function agree — it only returns `true` for
`UNSANDBOXED` / `SANDBOX_CODE_ONLY`. An isolate-mode engine (`SANDBOX_PROCESS`,
`SANDBOX_CODE_AND_PROCESS`) is always told there is no store (`AP_QADAM_VERSION_STORE_PATH`
empty) and always loads the image's bundled build, regardless of what version a flow is
pinned to — the exact "a path substitutes a different version silently" failure mode #779's
own "Done means" rules out, just scoped to isolate mode instead of forked mode. The comment
is explicit about why it isn't done here: "mounting the store needs its own design (only the
official tree and the job's own platform namespace, never the rest; a mount point outside
the sandbox's `/root`, which holds a `node_modules`)". The engine already provides
`@aiqadam/*` and `zod` to the store for forked mode (`qadam-platform-modules.ts`); isolate
mode's equivalent is the open half.

"Custom qadams in the store" (the `qadams/_platform/<platformId>/` namespace the layout
already reserves) is likewise unbuilt: `qadam-install-service.ts` still installs a custom
qadam the pre-ADR-0003 way, and no install path writes a custom qadam into that namespace yet
(the layout, platform-modules resolution and GC code all already know the namespace's shape —
`qadam-version-store-layout.ts`, `qadam-platform-modules.ts`, `qadam-version-store-gc.ts` — they
just have nothing to act on there).

Neither of these has its own issue yet — both are currently just a sentence inside #779 and
#805's documentation, not a tracked, scoped ticket.

## Recommendation

- Review and merge #1034; it is the open, conflict-resolved, further-along vehicle for this
  branch's last two commits. Landing it closes the two gaps those commits addressed (agent-tool
  framework-version marking, the stored-pin floor fallthrough) — `pieces.md`'s own list still
  names one more forked-mode item outside this branch's scope, removing `qadamPinFallback`'s
  caret-range stand-in once #808's audited move covers every path.
- This PR (being a no-op against `main`) can be closed without merging once #1034 lands, or
  merged harmlessly before it — either order is safe since it changes nothing but this file.
- Split "isolate-mode store mounting" and "custom qadams in the store" into their own issues
  before anyone picks them up — each needs its own design pass (the sandbox-mount comment
  above is explicit that isolate mounting isn't a drive-by change), and neither belongs
  bundled into whatever ticket touches them next, the same reasoning #214's research note
  (`docs/research/214-three-uncalled-functions-hide-live-bugs.md`) applied to its own two
  deferred epics.
