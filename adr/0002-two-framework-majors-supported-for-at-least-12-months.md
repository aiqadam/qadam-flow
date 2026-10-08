---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-08            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#775"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0002. The platform supports two framework majors for at least 12 months, enforced by a CI gate

Builds on: ADR-0001 (what a framework major is, the SDK, the gate set and the `versioning` rule).

## Decision

From `@aiqadam/qadams-framework@1.0.0` (ADR-0001), the engine ↔ qadam contract follows the
framework's semver as ADR-0001 defines it: a new `context` version is a new **framework major**, and the
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
- **A convention** in `.agents/rules/versioning.md` (ADR-0001's rule, listed in the AGENTS.md rules
  index) and in `CONTRIBUTING.md` states the rule for agents and humans and points at the table
  and the gate.

Each instance makes a retirement safe locally with a **census**: from its own database it counts
the steps pinned to qadam versions built against each major, and needs each pinned version's context version:
- **Official qadams** never have rows in `qadam_metadata` (only custom installs write there, and
  #503 refuses official names). Every official version built in this repository reports context V2
  (`LATEST_CONTEXT_VERSION` since `f611ac80`); from `1.0.0` on, an official version's framework major
  is the major of `@aiqadam/qadams-framework` that its published `package.json` depends
  on, which the support table maps to a context version.
- **Custom and installed qadams** — the population the shims protect — need a new `qadam_metadata`
  column: `contextInfo` exists today only on the in-memory metadata type
  (`packages/qadams/framework/src/lib/qadam-metadata.ts:112-117` at `94dc9ae3`) and is not persisted
  (`packages/server/api/src/app/qadams/metadata/qadam-metadata-entity.ts` has no such column). A
  custom pin whose context version is unknown counts as "still needs the old contract", so the
  census errs towards keeping a shim.

Before an upgrade a `doctor` command lists the steps a release will stop running; after it, affected steps are marked
"framework version no longer supported — update this step" in the builder, MCP and runs, an
operator banner and log line appear, and the release starts normally — it does not block, and no
flow is disabled (#435). The `Remove after 2026-10-12` date on the current shims is withdrawn.

Before 1.0.0 there is no guarantee: official qadams are built against the current framework. The
existing shims (context V1, and qadams predating `getContextInfo`) belong to no framework major, so
the support table starts with a `0.x` row for them whose successor is `1.0.0`: they are retired by
the same rule, no earlier than 12 months after `1.0.0`.

This ADR adds **gate 8** to ADR-0001's required set: the support-table gate above.

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
  framework — custom qadams uploaded to an instance, and external authors' qadams.
- Qadam Flow is self-hosted with no central telemetry, and on-prem upgrade cadence varies, so
  "is anyone still on the old contract" can only be answered on each instance, offline.
- External authors will build against the SDK (the 2026-10-08 session, `adr/assets/2026-10-08-versioning-session.md`), so the window is a public promise.

## Options considered

### Option A — two framework majors, at least 12 months, CI gate and local census (chosen)

Semver gives authors one rule they already know. The 12-month floor protects instances that upgrade
once a year if majors ever come quickly. The gate turns "someone must remember" into a failing
check, and the census turns retirement from a run-time surprise into a visible, repairable list.
Comparable: Kubernetes keeps a GA API at least 12 months or 3 releases after deprecation,
whichever is longer (https://kubernetes.io/docs/reference/using-api/deprecation-policy/).

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
the pattern whose own last instance says "the next republish after this one needs its own file
too" (`packages/server/api/src/app/flows/flow-version/migrations/migrate-v30-ai-qadam-version-redo-4.ts`).

### Option F — block the upgrade until an operator confirms

Rejected. Upgrades are `docker compose pull`; a container that refuses to start is a worse outage
than marked steps with a clear repair path.

## Consequences

- A framework major requires a support-table row and keeps the engine shim for the previous major.
  It needs no operator action, so it is not a platform major.
- **Retiring** a major — removing its shim — is what operators notice: it is a platform major under
  ADR-0001, with its `breaking-changes.mdx` entry (gate 4) and the census output to act on.
- Supporting two or occasionally three majors costs a branch and a small adapter per major in the
  engine — today's shims are that size.
- The census needs a home in the CLI (`doctor`), the admin UI and `ap_flow_structure`; it treats an
  unresolvable pin as "still needs the old contract".
- The rule and the gate land with the implementation, after this ADR is accepted.

## Evidence

- `LATEST_CONTEXT_VERSION = ContextVersion.V2` at `f611ac80` and at `94dc9ae3`
  (`packages/qadams/framework/src/lib/context/versioning.ts:17`).
- Prototype on `94dc9ae3`: `tables@0.3.1`, `@0.4.5` and `@0.5.1` all report `contextVersion=2`
  (`adr/assets/2026-10-08-versioning-prototype/load-versions.js`).
- `@aiqadam/qadams-framework` is at `0.35.0` on `94dc9ae3`; no 1.0.0 has been published.

## Follow-ups

- Support table and the CI gate (removal, missing row, unsupported major), with fixture tests.
- The support-window paragraph in `.agents/rules/versioning.md` and `CONTRIBUTING.md` (ADR-0001).
- Replace the `Remove after 2026-10-12` comments with a reference to this ADR (#775).
- Persist `contextInfo` for custom and installed qadams in `qadam_metadata` (new column; existing
  rows backfilled by loading the stored archive, unknown otherwise).
- Census: query over stored flow versions → pinned `name@version` → context version (official:
  context V2 before `qadams-framework@1.0.0`, then the framework major in its `package.json`
  mapped through the support table; custom: `qadam_metadata`); `doctor` command; admin and MCP surfaces; post-upgrade marking.
- SDK docs: the support window for qadam authors.
