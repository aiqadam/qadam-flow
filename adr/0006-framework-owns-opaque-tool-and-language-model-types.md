---
status: proposed            # proposed | accepted | rejected | superseded | deprecated
date: 2026-10-25            # date of the decision; the draft date while proposed
deciders: []                # GitHub handles of the maintainers who decided
issue: "#908"               # where the discussion happened
supersedes: null            # "NNNN" (or ["NNNN", "NNNN"]) if this replaces earlier ADRs
superseded-by: null         # set when a later ADR replaces this one
---

# 0006. `qadams-framework` owns opaque `Tool`/`LanguageModel` placeholder types instead of re-exporting `ai`'s

## Decision

`@aiqadam/qadams-framework`'s public context API (`ConstructToolParams.model`,
`AgentContext.tools()`'s return type) stops using `ai`'s own `LanguageModel` / `Tool` types and
instead uses framework-owned placeholder types (`unknown`, under the same names as before — but,
as before, not themselves exported; only `ConstructToolParams`/`AgentContext` are). The framework
no longer depends on `ai` at all. Every consumer that
needs the concrete `ai` SDK shape — today `@aiqadam/engine` (builds the `model` value and reads the
`Tool` records it hands back) and `@aiqadam/qadam-ai` (the only qadam calling
`context.agent.tools()`) — asserts the concrete type at its own call site, once, where it already
depends on `ai` directly.

## Context

- At `97a61649` (the commit this ADR branches from): `ConstructToolParams.model: LanguageModel` and
  `AgentContext.tools(): Promise<Record<string, Tool>>`
  (`packages/qadams/framework/src/lib/context/index.ts:16,317-323`) imported `LanguageModel` /
  `Tool` straight from `ai`, which re-exports `Tool` / `FlexibleSchema` from
  `@ai-sdk/provider-utils`; the two call sites that consume them were
  `packages/server/engine/src/lib/handler/qadam-executor.ts:145,149` and
  `packages/qadams/community/ai/src/lib/actions/agents/tools.ts:296,313-314`.
- `ai` is a regular (not peer) dependency, exactly pinned, in `qadams-framework`, in
  `@aiqadam/engine`, and in every qadam that touches it (e.g. `@aiqadam/qadam-ai`). Each can resolve
  a different patch of `@ai-sdk/provider-utils` under `bun`'s nested install, and two different
  patches of that package are not structurally assignable to each other — a hard `TS2322`, not a
  warning, and invisible to the repo-wide `typecheck` because qadams have no `typecheck` script
  (their `build` is the only check).
- This has broken a real build twice, by the line numbers true at each PR's own head: PR #896 (`ai`
  bump) hit `TS2322` at `qadam-executor.ts:142` (`ToolSet` vs. `Record<string, Tool>`) because
  Renovate updates `server/*`/`web` but `renovate.json` excludes `packages/qadams/**`; re-aligning
  only the framework then moved the same break to `@aiqadam/qadam-ai`'s
  `src/lib/actions/agents/tools.ts:378`. #815 hit the identical shape earlier. Both were fixed by
  hand-aligning the three `ai` pins — a fix that does not scale to external qadam authors, who pin
  whatever `ai` version they choose.
- Decided in `#908` (comment
  https://github.com/aiqadam/qadam-flow/issues/908#issuecomment-6396150457, 2026-10-25): "Variant
  2" — stop exposing `ai` types in the framework's public surface, convert at the engine boundary.
  Ticket for the implementation: `#961`.
- Needed before `qadams-framework@1.0.0` (`#786`), where the SDK starts making a real compatibility
  promise (ADR-0001) and an `ai` bump can no longer be absorbed as a patch by convention alone.

## Options considered

### Option A — framework-owned opaque placeholder types, converted at each consumer's own boundary (chosen)

`LanguageModel` / `Tool` become framework-local type aliases with no dependency on `ai`. The
emptiest honest shape is the one actually used *inside the framework*: nothing — the framework
only threads these values through an action's `context` without ever calling a method on them. Any
concrete object assigns into that placeholder with zero cast (anything is assignable to the widened
opaque shape); getting a concrete `ai` type back out needs exactly one assertion, written where the
code already has a real, version-specific dependency on `ai` and already trusts its own runtime
values: `@aiqadam/engine` (`qadam-executor.ts`, handing `params.model` to its own `agentTools.tools`;
the reverse direction — `agentTools.tools`'s own `Record<string, Tool>` return assigned up into
`Promise<Record<string, unknown>>` — needs none, since a concrete type always widens into an opaque
one for free) and `@aiqadam/qadam-ai` (`tools.ts`, reading `context.agent.tools()`'s result back as
its own `Tool`). Removes `ai` from `qadams-framework`'s dependencies entirely.

### Option B — `ai` as a peerDependency with a declared range

Rejected. Forces every qadam author and the platform itself onto one shared `ai`/`@ai-sdk/provider-utils`
range, which is exactly the coupling this ADR exists to remove — an author who needs a newer
provider than the platform ships is blocked, not merely inconvenienced. Still breaks the day the
framework and a qadam disagree on which minor of the peer range to install, which `bun`'s
flattening cannot always prevent.

### Option C — keep the dependency, treat every `ai` bump as an SDK minor/major and gate CI on it

Rejected (for now; not a competing *type* design, so it doesn't fully overlap A — recorded for
completeness since #908 raised it as an alternative). Does not fix the underlying issue: two
different consumers can still resolve two different `@ai-sdk/provider-utils` patches at install
time regardless of what semver level the framework declares, so the `TS2322` keeps recurring; it
would only convert a silent break into a loud, correctly-leveled one. A CI job that builds every
`ai`-dependent qadam against the framework is still useful as a regression net and is not excluded
by choosing Option A, but it does not by itself solve the problem.

## Consequences

- `qadams-framework`'s `ConstructToolParams.model` and `AgentContext.tools()`'s return type change
  shape (real `ai` types → `unknown`) without changing name — a source-breaking change for any code
  that relied on the old types flowing through unchanged, SDK-minor on `0.x` per
  `.agents/rules/versioning.md`.
- `ai` is removed from `qadams-framework`'s `dependencies` — any qadam that imported `ai` types
  transitively through the framework (none currently do; framework never re-exported them) would
  need its own direct `ai` dependency, which every `ai`-touching qadam already declares.
  No engine ↔ qadam runtime contract changes (no `ContextVersion` bump): qadam authors still pass
  and receive the exact same runtime values: real `ai` SDK objects — only the compile-time types at
  this one API boundary are now opaque.
- Every future consumer of `context.agent.tools()` takes on the same one-line assertion
  `@aiqadam/qadam-ai` and `@aiqadam/engine` take on here. That is the cost this ADR accepts
  deliberately: a visible, local, version-specific cast at each real boundary, instead of an
  invisible, version-fragile type flowing through a package that has no business knowing which `ai`
  patch is installed where.
- A qadam or the engine bumping its own `ai` dependency can no longer break another package's build
  through this API — the whole point of #908.
- Both conversion points (`qadam-executor.ts`, `tools.ts`) use an explicit `as` cast from the
  opaque `unknown` placeholder back to the concrete `ai` type. AGENTS.md's "No type casting" rule
  carries no exception list for this (unlike the HTTP-methods rule, which names its one sanctioned
  exception inline) — see Follow-ups.

## Evidence

Reproduced the exact `TS2322` class this ADR closes, and confirmed the fix survives it, on a
clean `bun install` (arm64 Linux, bun 1.4.3), machine-local, 2026-10-25:

1. At `97a61649` (pre-change): temporarily pinned `packages/qadams/community/ai/package.json`'s
   own `ai` to `7.0.133` (→ `@ai-sdk/provider-utils@5.0.57`) while its *direct*
   `@ai-sdk/provider-utils` dependency stayed `5.0.62` (the version the engine's `ai@7.0.143` also
   resolves) — the same shape of split #896 hit, reproduced inside one package's own dependency
   graph. `bun install && npx turbo run build --filter=@aiqadam/qadam-ai --force` failed:
   `src/lib/actions/agents/tools.ts(378,9): error TS2322: Type '{ [x: string]: Tool | Tool; }' is
   not assignable to type 'Record<string, Tool>' ... Property '[schemaSymbol]' is missing in type
   '...@ai-sdk+provider-utils@5.0.62.../Schema<any>' but required in type
   '...@ai-sdk+provider-utils@5.0.57.../Schema<any>'` — line and shape match #896's report exactly.
2. Checked out this ADR's implementation (this commit) on top of the same divergent install (no
   reinstall): `npx turbo run typecheck --filter=@aiqadam/engine --force` and
   `npx turbo run build --filter=@aiqadam/qadam-ai --force` both passed clean, no `TS2322`.
3. Reverted the temporary `ai` pin and lockfile change; confirmed `bun install` returns to the
   committed lockfile with no diff.

## Follow-ups

- The CI build-every-`ai`-qadam safety net from Option C remains open as a separate, independent
  hardening step; not required by this ADR.
- `#786` (`qadams-framework@1.0.0`) can proceed without this class of break blocking it.
- Once this ADR is accepted: name the two `as` casts above (`qadam-executor.ts`, `tools.ts`) as a
  sanctioned exception in AGENTS.md's "No type casting" bullet (the way `PUT /v1/files/:fileId` is
  named under "HTTP"), and mirror the wording into `.opencodereview/rules/` so neither a human
  reviewer nor `npm run review` keeps re-flagging the one place this ADR requires a cast.
