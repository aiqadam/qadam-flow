# #851 — "Main builds give changed packages `<next>-main.<n>` snapshot versions; image assembly
from the release archive (ADR-0004)": what Part 1 (#877) left open, re-verified against the current
tree

**Status:** item 4 (the two low review notes) is fixed in this PR (small, well-scoped, low risk).
Items 1 and 3 turn out to be already partly fixed, by earlier, unrelated PRs that landed before this
session started — see Findings 1 and 3. Items 1 (the rest of it) and 2 — applying the snapshot plan
to the actual image, and wiring the release archive into `release.yml` — are not attempted here; this
doc records why, and what is now actually true of each, so a focused follow-up session does not have
to re-derive it.

**Investigated:** 2026-11-12, on `agent/851-main-builds-give-changed-packages-next-m` (branch at
`main`'s current head, `50adc349`).

## What #877's own closing comment listed as "not done, so this ticket stays open"

1. "The image does not apply the plan yet: `qadam-metadata-service.ts` resolves pins with
   `semVer.satisfies(candidate, '^<pin>')` without `includePrerelease`, so `0.6.1-main.5` does not
   satisfy a flow pinned `^0.6.0`, and the image does not seed the released version into the store.
   Stamping now would orphan pinned flows on QA until the `follow` policy (#854) and the store seed
   (#807) exist."
2. "The release archive is not wired (#804's checklist), so every plan takes the no-archive
   fallback; release mode refuses a `>=1.0.0` qadam missing from the archive unless named in
   `--produced`, and nothing calls it from `release.yml` yet."
3. "`builtAgainst` is not surfaced in audit records or the census."
4. Two low review notes: the "neither check has to be right alone" comment in `qadam-artifact.mjs`
   overclaims, and `snapshot-plan.mjs`'s package-name rule on plan entries has no dedicated test.

## Finding 1: item 1's own blocking premise is stale — the `semVer.satisfies` problem is already fixed

`qadam-metadata-service.ts` no longer calls `semVer.satisfies` at all. The caret/tilde/exact match is
now done with an explicit `baseVersion`/`nextExcludedVersion` range
(`packages/server/api/src/app/qadams/metadata/qadam-metadata-service.ts:509-520`), with this comment
sitting directly on it:

> The range below ends at the pin's next patch, which a prerelease of that patch sits inside
> (`1.3.1-main.5` is below `1.3.1`), so an exact pin matches by equality (#779, ADR-0004).

`git log -S "semVer.satisfies" -- packages/server/api/src/app/qadams/metadata/qadam-metadata-service.ts`
shows the call was removed by `58d09ab1` ("feat(qadams): move steps off an unavailable qadam pin with
caret, props and load checks, an audit record and a revert (ADR-0003, #808) (#882)", 2026-10-10
18:13), and the quoted comment itself (the "(#779, ADR-0004)" one above) was added earlier the same
day by `e743ad0e` ("feat(qadams): exact pins run the build they name or fail with the pin named;
agent tools are provisioned (ADR-0003, #779) (#878)", 2026-10-10 14:41). Both are descendants of
#877 (`db1da016`, 2026-10-10 13:35). So the specific defect the #851 comment names — a `-main.<n>`
prerelease failing to satisfy its release's caret range — no longer exists; a worked example is
exercised by `qadam-pin-fallback-decision.ts`'s `checkNet`, which the feature doc
(`.agents/features/qadam-pin-moves.md`) now states plainly: "the image's version is inside the pin's
caret range (ADR-0001, prereleases counted, ADR-0004)".

**The second half of item 1 — the store seed — is also not what the comment implies.** #807's own PR
(#1053, merged 2026-11-11, well after #878/#882) deliberately did **not** wire `build-image-seed.mjs`
into the Dockerfile, but for a different, more specific reason than "the store seed doesn't exist yet" — the
tool exists and is tested (`tools/ci/test-image-seed.sh`). The Dockerfile's own comment
(`Dockerfile:120-138`) gives the real reason: seeding a `:main` build **today** would let the first
`:main` image's code for an *unbumped* version win forever on a persisted store volume (the store
never overwrites an already-stored version), silently masking every later `:main` image's changes
under that same version — explicitly because "`#851` not landed, so `tools/scripts/qadams/snapshot/`
computes what version a build would get but... the image does not apply it yet." In other words: this
is not an independent prerequisite #851 is waiting on — it is the exact problem applying the snapshot
plan to the image *solves*, because every qadam with a pending changeset then gets a unique
`-main.<n>` per build, not an unbumped version with changed code. There is no more "unbumped version,
changed code" case once the plan is applied, so there is nothing left for the version store to
silently mask.

**Net effect: the two things item 1's own text cites as blockers (`follow` policy #854, and the
caret-match bug) are both done.** What remains for item 1 is purely integration work. The plan
computation itself already runs in CI: `ci.yml:1054-1078` (the `platform-version` job) calls
`compute-snapshot-plan.mjs` on every build and writes its summary to the step summary, but
`continue-on-error: true` and, per its own comment, "NOT applied to the image" — the plan file it
writes is never read by anything downstream. What is missing is applying that plan: running
`build-qadam-artifacts.mjs --snapshot-plan` (or an equivalent in-place rewrite) against each qadam's
own `package.json` before the image's run stage copies it in, and calling `build-image-seed.mjs` to
seed the store from the result. All three tools exist and are independently tested
(`tools/ci/test-qadam-snapshot-plan.sh`, `tools/ci/test-qadam-artifacts.sh`,
`tools/ci/test-image-seed.sh`); the first is wired into `ci.yml` as an advisory, discarded step, and
the other two are not wired into `Dockerfile` or `ci.yml` at all today.

## Finding 2: item 2 is correctly attributed to #804, which is still mostly unchecked

`gh issue view 804` shows every scope checkbox unchecked: bundle build per qadam, the native-module
exception format, `metadata.json` generation, publishing with `@aiqadam/*`/`zod` as peer
dependencies, and "archive release artifacts when built, and never rebuild them from git" are all
still open. Today the only `>=1.0.0` official qadam (`qadam-assemblyai@2.0.0`) still ships through the
*legacy* npm-source publish pipeline (`_pack-framework-packages.yml` →
`tools/scripts/utils/stage-package-for-publish.ts`, the same path `qadams-framework` and
`qadams-common` use — `@aiqadam/shared` stopped being packed separately once #799 made it private and
bundled into `qadams-framework`'s own tarball), not through `build-qadam-artifacts.mjs`'s bundle
format — there is no production caller of the bundle builder or `release-archive.mjs` anywhere in
`.github/workflows/` yet. Wiring `release.yml` to call
`compute-snapshot-plan.mjs --mode release` would also need somewhere for the archive to live
*between* releases (a GitHub Release asset, a registry, ...) so the next release's `--archive` has
something to point at — that storage decision is `#804`'s own unchecked "archive release artifacts"
item, not something this ticket's text ever specified. Attempting it here would mean inventing that
design unreviewed. Left as is; `#804` is the right place for it, and `#851`'s own comment already
says as much ("The release archive is not wired (#804's checklist)").

## Finding 3: item 3 (census half) already shipped; the "audit records" half has no settled scope

The census already reads `builtAgainst` where a resolved pin is a stored version:
`packages/server/api/src/app/qadams/census/framework-census-service.ts`'s `PinContext.frameworkMajor`
doc comment reads "Known for a bundled official build (its `package.json`) and a stored one (its
`builtAgainst` record)" and the resolution code (same file, around line 368) does exactly that. `git
log -S builtAgainst` dates this to `0c1f7fce` ("feat(qadams): resolve stored qadam metadata in the API
and census (#779) (#966)", 2026-10-25) — a later, separate PR from the two that fixed the caret match
in Finding 1. So the census half of item 3 is done.

The "audit records" half has no code to point at and no settled design. The only per-step audit
record in this area is `qadam_pin_move` (`packages/server/api/src/app/qadams/pin-moves/`), the #808
record of a *pin rewrite*; it has no `builtAgainst` column, and adding one is not obviously the right
shape — a pin move's audit value is "what moved and why", and `builtAgainst` is a property of the
*target version*, already resolvable live through the census/store the same way everything else reads
it. Rather than add a column or a new table on a guess, this is flagged here for whoever scopes it
next to say what "surfacing `builtAgainst` in audit records" is actually supposed to let an operator
see that the census does not already show.

## What this PR changes

- `tools/scripts/qadams/bundle/qadam-artifact.mjs`: the "neither check has to be right alone" comment
  is corrected. `PACKAGE_NAME` and `PLAN_VERSION` (`snapshot-plan.mjs`) allow no `/` or `\` and no
  segment can ever be the literal string `..` (every segment starts with a letter or digit, and
  `PLAN_VERSION` is a fixed numeric-and-`-main.<n>` shape) — an ordinary dotted version like `1.2.3`
  or a dotted package name is still fine, it is specifically a `..` segment or a path separator that
  neither regex admits. So the value checks are independently sufficient against path traversal
  today, and the path check after them is a second line of defense (a future loosening of either
  regex, not a gap either one leaves open now), not an equally load-bearing twin of the value checks.
- `tools/ci/test-qadam-snapshot-plan.sh`: adds the missing case for the package-name rule
  (`describeEntryProblem`'s `'name is not a package name'` branch in `snapshot-plan.mjs`), mirroring
  the existing "a version that is a path is refused" case. 84 cases pass (was 83).

## Recommendation

- Leave #851 open. Items 1 and 2 are real, scoped, and buildable on tooling that already exists and is
  tested, but both are integration work against the main image/release pipeline (item 1) or blocked on
  a separate issue's unbuilt foundation plus an un-made storage decision (item 2) — neither is a
  same-session, low-risk change.
- A focused follow-up for item 1 should: run `compute-snapshot-plan.mjs` in the `build` stage (or a
  preceding CI step passed in as a build context file), apply each plan entry's version to that
  qadam's own `dist/package.json` before the run stage copies it in, and call `build-image-seed.mjs`
  against the result before `docker build` finishes — then re-verify end to end (a real `:main` boot,
  a flow pinned to a changed qadam's release version still resolving through `follow`/`checkNet`, and
  the store-seed-wins-forever scenario no longer being reachable) before removing the Dockerfile's
  "NOT wired up here" comment.
- Item 2 should wait on `#804`'s own checklist (bundle build, `metadata.json`, peer-dependency
  publishing) and an explicit decision on where an archive persists between releases.
