# @aiqadam/qadam-ai

## 0.7.0

### Minor Changes

- b1fc9d2: Describe AI models by capability — input and output modalities, whether they can chat and call tools — instead of a single `image`/`text` type, and drop the hardcoded chat model allow-list that went stale as providers retired and added models (#848).
  
  - The chat and the agent-step model picker now offer every model the provider reports as chat-capable, instead of intersecting the catalogue with a list that shipped in code.
  - `AIProviderModel` gains a required `capabilities` field. `type` stays on the wire, derived from the capabilities, so pinned qadam versions that still filter on it keep working.
  - `@aiqadam/qadam-ai` filters its text and image model dropdowns on the capability the action needs (falling back to `type` against an older platform), so an embedding model is no longer offered to `ask-ai` and a multimodal model reaches both actions.

### Patch Changes

- 34efa2b: Depend on `ai` 7.0.129 and its `@ai-sdk/provider-utils` 5.0.55, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils` (#815). The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- 47c9525: Update third-party dependencies (Renovate).
- Updated dependencies [66d8bad]
- Updated dependencies [14ea41c]
- Updated dependencies [34efa2b]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
- Updated dependencies [47c9525]
  - @aiqadam/qadams-framework@0.37.0
  - @aiqadam/qadams-common@0.17.2
