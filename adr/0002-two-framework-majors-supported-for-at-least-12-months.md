---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#775"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0002. The platform supports two framework majors for at least 12 months, enforced by a CI gate

## Decision

From `@aiqadam/qadams-framework@1.0.0` (cut as described in ADR-0001), the engine ↔ qadam contract
follows semver on the framework: a new `context` version is a new **framework major**, and the
platform runs qadams built against the **current and the previous major**. A previous major stays
supported for **at least 12 months after the next major is released**, even if a third major
ships in that time.

The policy is enforced, not remembered:
- **A support table** in the repository records, for each framework major, its context version,
  its release date and the release date of the major that followed it. It is the source of truth.
- **A deterministic CI gate** fails when a context shim is removed from the engine while the table
  says its major is still supported, when a framework major is released without a row, or when an
  official qadam is built against a major the engine no longer supports. The gate is monotonic:
  the passage of time can only allow a removal, never make existing code fail.
- **A convention** in `.agents/rules/` (listed in the AGENTS.md rules index) and in
  `CONTRIBUTING.md` states the rule for agents and humans and points at the table and the gate.

Each instance makes a retirement safe locally with a **census**: from its own database and qadam
store it counts the steps pinned to qadam versions built against each major. Before an upgrade a
`doctor` command lists the steps a release will stop running; after it, affected steps are marked
"framework version no longer supported — update this step" in the builder, MCP and runs, an
operator banner and log line appear, and the release starts normally — it does not block, and no
flow is disabled (#435). The `Remove after 2026-10-12` date on the current shims is withdrawn.

Before 1.0.0 there is no guarantee: official qadams are built against the current framework, and
the existing shims stay until this policy retires them.

## Context

- A qadam reports the context version it was built against through `getContextInfo()`; the engine
  adapts the context for older ones at execution time
  (`packages/server/engine/src/lib/handler/qadam-executor.ts:179` →
  `backwardCompatabilityContextUtils.makeActionContextBackwardCompatible`,
  `packages/qadams/framework/src/lib/context/versioning.ts` at `94dc9ae3`).
- The shims for V1 and for qadams predating `getContextInfo` are marked
  `@deprecated Since 2026-04-12. Remove after 2026-10-12` (`versioning.ts:52`, `:68`). Nothing in the
  platform gates that removal against stored flows (#775).
- Every official qadam built in this repository reports V2: `LATEST_CONTEXT_VERSION` was already `V2`
  at the fork's first commit (`f611ac80`). The shims protect only qadams built against an older
  framework — custom qadams uploaded to an instance, and, after ADR-0001, external authors' qadams.
- Qadam Flow is self-hosted with no central telemetry, and on-prem upgrade cadence varies, so
  "is anyone still on the old contract" can only be answered on each instance, offline.
- External authors will build against the SDK (recorded on #433), so the window is a public promise.
- The platform's own version scheme is still open (#776); this policy is keyed to the framework's
  semver, not to platform release numbers, so it does not wait for #776.

## Options considered

### Option A — two framework majors, at least 12 months, CI gate and local census (chosen)

Semver gives authors one rule they already know. The 12-month floor protects instances that upgrade
once a year if majors ever come quickly. The gate turns "someone must remember" into a failing
check, and the census turns retirement from a run-time surprise into a visible, repairable list.
Comparable: Kubernetes keeps a stable API at least 12 months or 3 releases after deprecation.

### Option B — two majors, no time floor

Rejected. Two majors released within six months would retire the oldest after six months, and an
instance that upgrades yearly would skip straight past its window.

### Option C — a time window only, unrelated to majors

Rejected. It throws away the signal semver already carries for authors, and needs a separate
deprecation announcement per context change.

### Option D — remove on a calendar date (the current comments)

Rejected. A date in a comment is not a mechanism: when the shims go, flows pinned to older qadams
fail at run time on someone's instance with no warning (#775).

### Option E — a pin migration per retirement (the `migrate-v24` … `v30` shape)

Rejected. A hand-written file per change that silently moves published steps onto different code —
the pattern ADR-0001 ends.

### Option F — block the upgrade until an operator confirms

Rejected. Upgrades are `docker compose pull`; a container that refuses to start is a worse outage
than marked steps with a clear repair path.

## Consequences

- A framework major requires: a support-table row, a breaking-change entry in
  `docs/install/configuration/breaking-changes.mdx` (through the `breaking-change-gate` in
  `.github/workflows/release.yml`), and the engine shim for the previous major kept.
- Supporting two or occasionally three majors costs a branch and a small adapter per major in the
  engine — today's shims are that size.
- The census needs a home in the CLI (`doctor`), the admin UI and `ap_flow_structure`; it treats an
  unresolvable pin as "still needs the old contract".
- The rule and the gate land with the implementation, after this ADR is accepted.

## Evidence

- `LATEST_CONTEXT_VERSION = ContextVersion.V2` at `f611ac80` and at `94dc9ae3`
  (`packages/qadams/framework/src/lib/context/versioning.ts:17`).
- ADR-0001 prototype: `tables@0.3.1`, `@0.4.5` and `@0.5.1` all report `contextVersion=2`.
- `@aiqadam/qadams-framework` is at `0.35.0` on `94dc9ae3`; no 1.0.0 has been published.

## Follow-ups

- Support table and the CI gate (removal, missing row, unsupported major), with fixture tests.
- Convention rule in `.agents/rules/` + AGENTS.md index row; paragraph in `CONTRIBUTING.md`.
- Replace the `Remove after 2026-10-12` comments with a reference to this ADR (#775).
- Census: query over stored flow versions → pinned `name@version` → framework major from the store
  metadata (ADR-0001); `doctor` command; admin and MCP surfaces; post-upgrade marking.
- SDK docs: the support window for qadam authors.
