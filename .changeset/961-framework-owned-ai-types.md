---
"@aiqadam/qadams-framework": minor
"@aiqadam/qadam-ai": patch
---

`@aiqadam/qadams-framework`'s public context API (`ConstructToolParams.model`,
`AgentContext.tools()`'s return type) no longer re-exports `ai`'s own `LanguageModel` / `Tool`
types — it now uses framework-owned opaque placeholders, and the `ai` dependency is dropped from
the framework entirely (ADR-0006, #961, #908). Two differently-pinned copies of `ai` (framework vs.
a qadam's own, or the platform's) previously produced a hard `TS2322` at this boundary whenever
their `@ai-sdk/provider-utils` patch versions diverged (#815, #896); this closes that class of
break without requiring every consumer to share one `ai` version. This is a source-breaking change
for any code that relied on the old (real `ai`) types flowing through `ConstructToolParams`/
`AgentContext` unchanged — none does today outside `@aiqadam/engine` and `@aiqadam/qadam-ai`, both
updated here to convert back to the concrete `ai` type at their own call site. No runtime or
engine ↔ qadam contract change: a qadam still passes and receives the exact same `ai` SDK objects
at execution time.
