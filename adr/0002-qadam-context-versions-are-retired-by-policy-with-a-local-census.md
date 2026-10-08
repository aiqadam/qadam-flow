---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#775"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0002. Qadam context versions are retired by published policy, made safe by a local census

## Decision

The engine supports the current qadam `context` version and the one before it (N and N-1). A
version is retired only after it has been announced deprecated for **at least 12 months or 3
releases, whichever is longer**. Retirement is a release decision we make centrally; each instance
makes it safe locally with a **census** — counting, from its own database and qadam store, how many
steps are pinned to qadam versions built against each context version. The census runs as a
pre-upgrade check (an operator sees which steps a release will stop running, with an "update
step" action) and after the upgrade (affected steps are marked "context version no longer
supported — update this step" in the builder, MCP and runs; they never fail silently and never
disable a flow). The `Remove after 2026-10-12` date on the current shims is withdrawn.

## Context

- A qadam reports the context version it was built against through `getContextInfo()`; the engine
  adapts the context for older ones at execution time
  (`packages/server/engine/src/lib/handler/qadam-executor.ts:179` →
  `backwardCompatabilityContextUtils.makeActionContextBackwardCompatible`,
  `packages/qadams/framework/src/lib/context/versioning.ts` at `94dc9ae3`).
- The shims for V1 and for qadams predating `getContextInfo` are marked
  `@deprecated Since 2026-04-12. Remove after 2026-10-12` (`versioning.ts:52`, `:68`). Nothing in the
  platform gates that removal against stored flows (#775).
- Every official qadam built in this repository reports V2: `LATEST_CONTEXT_VERSION` was already
  `V2` at the fork's first commit (`f611ac80`). The shims protect only qadams built against an older
  framework — custom qadams uploaded to an instance, and, once ADR-0001 lands, whatever external
  authors publish.
- Qadam Flow is self-hosted with no central telemetry, so "is anyone still on V1" can only be
  answered on each instance, from its own data, without network.
- External authors will build qadams against the SDK (recorded on #433), so the support window is
  a public promise, not an internal convenience.

## Options considered

### Option A — N and N-1, a minimum deprecation period, a local census (chosen)

Gives authors a predictable window, keeps the shims as cheap as they are today (one branch plus a
small adapter per version), and turns retirement from a surprise at run time into a visible,
repairable list before and after the upgrade. Comparable policies: Kubernetes keeps a stable API at
least 12 months or 3 releases after deprecation; Chrome's Manifest V2 → V3 took about three years.

### Option B — remove on the calendar date (the current comments)

Rejected. A date in a comment is not a mechanism: when the shims go, flows pinned to older qadams
fail at run time on someone's instance with no warning (#775).

### Option C — keep every context version forever (Node-API style)

Rejected as a promise; not ruled out in practice. Additive context versions make old shims cheap,
but an unbounded promise prevents ever removing a context capability that turns out to be unsafe.

### Option D — a pin migration per retirement (the `migrate-v24` … `v30` shape)

Rejected. It needs a hand-written file per change and silently moves published steps onto different
code — the pattern ADR-0001 ends.

## Consequences

- A new context version requires: the deprecation notice for N-1 in `docs/install/configuration/breaking-changes.mdx`
  and the release notes, the retirement release named no earlier than the policy allows, and the
  census entries for it.
- The census needs a home: a pre-upgrade command (or start-up diagnostic) and a surface in the
  admin UI and `ap_flow_structure`. It must work offline and treat an unresolvable pin as "still
  needs the old context".
- Retiring a version is a breaking change for any instance whose census is non-zero, so it goes
  through the `breaking-change-gate` in `.github/workflows/release.yml`.
- Today the census reports zero V1 steps on any instance that runs only official qadams, so the V1
  shims can follow this policy without pressure; the 2026-10-12 comment is replaced by a reference
  to this ADR.

## Evidence

- `LATEST_CONTEXT_VERSION = ContextVersion.V2` at `f611ac80` and at `94dc9ae3`
  (`packages/qadams/framework/src/lib/context/versioning.ts:17`).
- Prototype for ADR-0001: `tables@0.3.1`, `tables@0.4.5` and `tables@0.5.1` all report
  `contextVersion=2`.

## Follow-ups

- Replace the `Remove after 2026-10-12` comments with a reference to this ADR (#775).
- Census: query over stored flow versions → pinned `name@version` → context version from the store
  metadata (ADR-0001); pre-upgrade command; admin and MCP surfaces.
- Post-upgrade marking of steps on a retired context version, without disabling flows (#435).
- Document the support window for qadam authors in the SDK docs.
