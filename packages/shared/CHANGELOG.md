# @aiqadam/shared

## 0.157.0

### Minor Changes

- 627eda5: Read the ADR-0002 support table and the engine's context versions from `qadams-framework`, and add the framework census wire schema to `shared` (#803).

### Patch Changes

- b40c189: Keep a step named `__proto__` in queued sample data: `ExecuteFlowJobData` / `ExecutePropertyJobData` no longer parse `sampleData` with `z.record`, which drops an own `__proto__` key (#489). The inferred type is unchanged.
- 66d8bad: `KnowledgeBaseFile` is now exported as its Zod schema, and `ProjectColor` is written as a plain type, so typescript-eslint 8.71.1 stops flagging them as "only used as a type" (#793). Both types are unchanged; nothing a qadam reaches through the framework changed.
- aa1658b: `UpdateFieldRequest` accepts `data.options` (and `name` becomes optional), so a table's STATIC_DROPDOWN options can be changed in place (#842). Nothing a qadam reaches through the framework changed: `Field`, `FieldType` and `StaticDropdownEmptyOption` are untouched.
- b1fc9d2: Describe AI models by capability — input and output modalities, whether they can chat and call tools — instead of a single `image`/`text` type, and drop the hardcoded chat model allow-list that went stale as providers retired and added models (#848).
  
  - The chat and the agent-step model picker now offer every model the provider reports as chat-capable, instead of intersecting the catalogue with a list that shipped in code.
  - `AIProviderModel` gains a required `capabilities` field. `type` stays on the wire, derived from the capabilities, so pinned qadam versions that still filter on it keep working.
  - `@aiqadam/qadam-ai` filters its text and image model dropdowns on the capability the action needs (falling back to `type` against an older platform), so an embedding model is no longer offered to `ask-ai` and a multimodal model reaches both actions.
- e986096: One version parser decides what a qadam version may look like: a release `x.y.z` or a snapshot `x.y.z-main.<n>`, and no other prerelease (ADR-0004, #850). A step's `qadamVersion` pin, the `release` query of the qadam list and registry, and the qadam alias now use it, and the alias is `name@version` (a legacy `name-version` alias is still read). The custom-qadam install schema keeps `x.y.z`. Nothing a qadam reaches through the framework changed: none of the changed exports is re-exported by it.
- c639f50: A flow export rewrites a pre-release (`x.y.z-main.<n>`) qadam pin to the newest compatible release, or to `^<base>` with the step listed as exported-unresolved when none passes the props check; the importer marks such a step "update this step" (ADR-0004, #853). `GET /v1/flows/:id/template` takes `sameInstance` (templates that stay on the instance keep their pins) and `keepSnapshots` (an explicit opt-in that keeps the pins and embeds each snapshot's `metadata.json`), in the UI export menu and in `ap_export_flow`. Instances running release images have no pre-release pins, so an export there is unchanged. What a qadam reaches through the framework changes only additively: `PopulatedFlow`, which the framework re-exports, gains optional `exportedUnresolvedPin` on a step's settings; none of the new exports is re-exported.
- e9c6861: Bound a qadam name to npm's 214-character limit in `AddQadamRequestBody`, and move
  `NPM_PACKAGE_NAME_MAX_LENGTH` into `shared` next to the name grammar so every schema and path
  check uses one number (#879). `shared` also gains `MAX_AGENT_TOOL_PINS` and
  `flowQadamUtil.countAgentToolPins`, the agent-step tool cap the API and worker enforce. The worker
  already treated a longer name as not found; this keeps one from being stored as a custom qadam.
  Nothing a qadam reaches through the framework changed.
- 18e5850: `ChatMessageFile.data` (part of `SendChatMessageRequest`) is now validated as bare base64. A string there used to be handed to the AI SDK as-is, which tries it as a URL before falling back to inline data — so an `http(s)://` or `data:` string made the chat API server fetch it with the SDK's own downloader, bypassing `safeHttp` / `AP_SSRF_ALLOW_LIST` (#942). The web client already only ever sends bare base64 (`FileReader.readAsDataURL`, posted after the comma), so this closes a server-side gap without changing what the app does.
- 9af2e0c: `RegistryQadamsRequestQuery` accepts a prerelease platform version as `release` (`2.1.0-main.5`), so `GET /v1/qadams/registry` — the builder's version list — answers images built from `main` instead of failing with 400 (#798). `ListQadamsRequestQuery` validates `release` the same way; that endpoint still refuses any `release` as deprecated.
- 777a794: Update third-party dependencies (Renovate).
