# @aiqadam/qadam-ai

## 0.7.0

### Minor Changes

- b1fc9d2: Describe AI models by capability — input and output modalities, whether they can chat and call tools — instead of a single `image`/`text` type, and drop the hardcoded chat model allow-list that went stale as providers retired and added models (#848).
  
  - The chat and the agent-step model picker now offer every model the provider reports as chat-capable, instead of intersecting the catalogue with a list that shipped in code.
  - `AIProviderModel` gains a required `capabilities` field. `type` stays on the wire, derived from the capabilities, so pinned qadam versions that still filter on it keep working.
  - `@aiqadam/qadam-ai` filters its text and image model dropdowns on the capability the action needs (falling back to `type` against an older platform), so an embedding model is no longer offered to `ask-ai` and a multimodal model reaches both actions.

### Patch Changes

- 34efa2b: Depend on `ai` 7.0.129 and its `@ai-sdk/provider-utils` 5.0.55, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils` (#815). The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- 482ecae: Depend on `ai` 7.0.133 and its `@ai-sdk/provider-utils` 5.0.57, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils`. The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- c2fde9a: Depend on `ai` 7.0.143 and its `@ai-sdk/provider-utils` 5.0.62, the versions the platform now runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils`. The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- 89aec70: Re-point the type-only `@aiqadam/shared` imports narrowed out of `qadams-framework`'s re-export list (#959) straight at `@aiqadam/shared` as `import type`. No behaviour change: `tsc` erases every one of these imports from the emitted JS, and `@aiqadam/shared` is added only as a `devDependency` (never installed by a consumer), the same pattern `@aiqadam/qadams-common` already uses for its tests. The seven symbols that would still be named in a shipped `.d.ts` are not re-pointed and stay framework exports, so neither qadam's tarball references the private package.
- 9ccf0d2: `@aiqadam/qadams-framework`'s public context API (`ConstructToolParams.model`,
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
- 47c9525: Update third-party dependencies (Renovate).
- 5a595a8: Update third-party dependencies (Renovate).
- Updated dependencies [b40c189]
- Updated dependencies [66d8bad]
- Updated dependencies [14ea41c]
- Updated dependencies [34efa2b]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [e9c6861]
- Updated dependencies [482ecae]
- Updated dependencies [c2fde9a]
- Updated dependencies [18e5850]
- Updated dependencies [89aec70]
- Updated dependencies [9ccf0d2]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
- Updated dependencies [47c9525]
- Updated dependencies [777a794]
  - @aiqadam/qadams-framework@0.37.0
  - @aiqadam/qadams-common@0.17.2
