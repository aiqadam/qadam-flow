# @aiqadam/qadams-framework

## 0.37.0

### Minor Changes

- 14ea41c: Re-export the connection-value types `context.auth` resolves to, so a qadam's declaration emit stays portable once `@aiqadam/shared` is no longer a dependency (#799).
- b1fc9d2: Describe AI models by capability — input and output modalities, whether they can chat and call tools — instead of a single `image`/`text` type, and drop the hardcoded chat model allow-list that went stale as providers retired and added models (#848).
  
  - The chat and the agent-step model picker now offer every model the provider reports as chat-capable, instead of intersecting the catalogue with a list that shipped in code.
  - `AIProviderModel` gains a required `capabilities` field. `type` stays on the wire, derived from the capabilities, so pinned qadam versions that still filter on it keep working.
  - `@aiqadam/qadam-ai` filters its text and image model dropdowns on the capability the action needs (falling back to `type` against an older platform), so an embedding model is no longer offered to `ask-ai` and a multimodal model reaches both actions.
- 89aec70: Narrow the qadam-facing `@aiqadam/shared` re-export surface before `1.0.0` (#959): remove 28 single-qadam DTOs that their owner only ever consumed as types — tables request/record types (`CreateRecordsRequest`, `Table`, `ListTablesRequest`, …), agent/MCP types (`AgentKnowledgeBaseTool`, `AgentMcpTool`, `McpTrigger`, `ExecuteToolResponse`, …) and AI-provider config types (`AIProviderModel`, `AzureProviderConfig`, …); see `packages/qadams/framework/src/lib/shared-reexports.ts`. These were a semver promise to external qadam authors for symbols nobody outside their own defining qadam needs. Note that several removed names are Zod schemas or enums in `@aiqadam/shared`, so this also removes value exports (for example `Table.parse` or the `UpsertAction` enum); that removal is the intended narrowing. Seven other single-qadam DTOs stay exported — `Field`, `Filter`, `PopulatedRecord` (tables) and `AgentResult`, `AgentTool`, `AgentOutputField`, `AgentFlowTool` (ai) — because they appear in those qadams' published `.d.ts`, where a type import still names `@aiqadam/shared`, and the publish gate rejects that. The remaining single-qadam runtime values (enums, functions, constants — e.g. `FieldType`, `AIProviderName`, the subflow headers) are unaffected and stay exported, because `@aiqadam/shared` is private/unpublished and cannot be a real runtime dependency of a standalone-published qadam.
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
- 627eda5: Read the ADR-0002 support table and the engine's context versions from `qadams-framework`, and add the framework census wire schema to `shared` (#803).

### Patch Changes

- b40c189: Keep a step named `__proto__` in queued sample data: `ExecuteFlowJobData` / `ExecutePropertyJobData` no longer parse `sampleData` with `z.record`, which drops an own `__proto__` key (#489). The inferred type is unchanged.
- 66d8bad: `KnowledgeBaseFile` is now exported as its Zod schema, and `ProjectColor` is written as a plain type, so typescript-eslint 8.71.1 stops flagging them as "only used as a type" (#793). Both types are unchanged; nothing a qadam reaches through the framework changed.
- 34efa2b: Depend on `ai` 7.0.129 and its `@ai-sdk/provider-utils` 5.0.55, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils` (#815). The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- aa1658b: `UpdateFieldRequest` accepts `data.options` (and `name` becomes optional), so a table's STATIC_DROPDOWN options can be changed in place (#842). Nothing a qadam reaches through the framework changed: `Field`, `FieldType` and `StaticDropdownEmptyOption` are untouched.
- e986096: One version parser decides what a qadam version may look like: a release `x.y.z` or a snapshot `x.y.z-main.<n>`, and no other prerelease (ADR-0004, #850). A step's `qadamVersion` pin, the `release` query of the qadam list and registry, and the qadam alias now use it, and the alias is `name@version` (a legacy `name-version` alias is still read). The custom-qadam install schema keeps `x.y.z`. Nothing a qadam reaches through the framework changed: none of the changed exports is re-exported by it.
- c639f50: A flow export rewrites a pre-release (`x.y.z-main.<n>`) qadam pin to the newest compatible release, or to `^<base>` with the step listed as exported-unresolved when none passes the props check; the importer marks such a step "update this step" (ADR-0004, #853). `GET /v1/flows/:id/template` takes `sameInstance` (templates that stay on the instance keep their pins) and `keepSnapshots` (an explicit opt-in that keeps the pins and embeds each snapshot's `metadata.json`), in the UI export menu and in `ap_export_flow`. Instances running release images have no pre-release pins, so an export there is unchanged. What a qadam reaches through the framework changes only additively: `PopulatedFlow`, which the framework re-exports, gains optional `exportedUnresolvedPin` on a step's settings; none of the new exports is re-exported.
- e9c6861: Bound a qadam name to npm's 214-character limit in `AddQadamRequestBody`, and move
  `NPM_PACKAGE_NAME_MAX_LENGTH` into `shared` next to the name grammar so every schema and path
  check uses one number (#879). `shared` also gains `MAX_AGENT_TOOL_PINS` and
  `flowQadamUtil.countAgentToolPins`, the agent-step tool cap the API and worker enforce. The worker
  already treated a longer name as not found; this keeps one from being stored as a custom qadam.
  Nothing a qadam reaches through the framework changed.
- 482ecae: Depend on `ai` 7.0.133 and its `@ai-sdk/provider-utils` 5.0.57, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils`. The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- c2fde9a: Depend on `ai` 7.0.143 and its `@ai-sdk/provider-utils` 5.0.62, the versions the platform now runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils`. The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- 18e5850: Vendors the `@aiqadam/shared` fix tightening `ChatMessageFile.data` (part of `SendChatMessageRequest`) to bare base64 (#942). No qadam reads this schema today, so nothing a qadam author ships changes.
- 9af2e0c: `RegistryQadamsRequestQuery` accepts a prerelease platform version as `release` (`2.1.0-main.5`), so `GET /v1/qadams/registry` — the builder's version list — answers images built from `main` instead of failing with 400 (#798). `ListQadamsRequestQuery` validates `release` the same way; that endpoint still refuses any `release` as deprecated.
- 47c9525: Update third-party dependencies (Renovate).
- 777a794: Update third-party dependencies (Renovate).
- Updated dependencies [b40c189]
- Updated dependencies [66d8bad]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [e9c6861]
- Updated dependencies [18e5850]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
- Updated dependencies [777a794]
  - @aiqadam/shared@0.157.0
