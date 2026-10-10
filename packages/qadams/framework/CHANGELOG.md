# @aiqadam/qadams-framework

## 0.37.0

### Minor Changes

- 14ea41c: Re-export the connection-value types `context.auth` resolves to, so a qadam's declaration emit stays portable once `@aiqadam/shared` is no longer a dependency (#799).
- b1fc9d2: Describe AI models by capability — input and output modalities, whether they can chat and call tools — instead of a single `image`/`text` type, and drop the hardcoded chat model allow-list that went stale as providers retired and added models (#848).
  
  - The chat and the agent-step model picker now offer every model the provider reports as chat-capable, instead of intersecting the catalogue with a list that shipped in code.
  - `AIProviderModel` gains a required `capabilities` field. `type` stays on the wire, derived from the capabilities, so pinned qadam versions that still filter on it keep working.
  - `@aiqadam/qadam-ai` filters its text and image model dropdowns on the capability the action needs (falling back to `type` against an older platform), so an embedding model is no longer offered to `ask-ai` and a multimodal model reaches both actions.
- 627eda5: Read the ADR-0002 support table and the engine's context versions from `qadams-framework`, and add the framework census wire schema to `shared` (#803).

### Patch Changes

- 66d8bad: `KnowledgeBaseFile` is now exported as its Zod schema, and `ProjectColor` is written as a plain type, so typescript-eslint 8.71.1 stops flagging them as "only used as a type" (#793). Both types are unchanged; nothing a qadam reaches through the framework changed.
- 34efa2b: Depend on `ai` 7.0.129 and its `@ai-sdk/provider-utils` 5.0.55, the versions the platform already runs, so the framework's `Tool` type and the AI qadam's provider factories no longer come from two copies of `provider-utils` (#815). The AI qadam's `@ai-sdk/*` providers move to the matching releases. No API changed.
- aa1658b: `UpdateFieldRequest` accepts `data.options` (and `name` becomes optional), so a table's STATIC_DROPDOWN options can be changed in place (#842). Nothing a qadam reaches through the framework changed: `Field`, `FieldType` and `StaticDropdownEmptyOption` are untouched.
- e986096: One version parser decides what a qadam version may look like: a release `x.y.z` or a snapshot `x.y.z-main.<n>`, and no other prerelease (ADR-0004, #850). A step's `qadamVersion` pin, the `release` query of the qadam list and registry, and the qadam alias now use it, and the alias is `name@version` (a legacy `name-version` alias is still read). The custom-qadam install schema keeps `x.y.z`. Nothing a qadam reaches through the framework changed: none of the changed exports is re-exported by it.
- c639f50: A flow export rewrites a pre-release (`x.y.z-main.<n>`) qadam pin to the newest compatible release, or to `^<base>` with the step listed as exported-unresolved when none passes the props check; the importer marks such a step "update this step" (ADR-0004, #853). `GET /v1/flows/:id/template` takes `sameInstance` (templates that stay on the instance keep their pins) and `keepSnapshots` (an explicit opt-in that keeps the pins and embeds each snapshot's `metadata.json`), in the UI export menu and in `ap_export_flow`. Instances running release images have no pre-release pins, so an export there is unchanged. What a qadam reaches through the framework changes only additively: `PopulatedFlow`, which the framework re-exports, gains optional `exportedUnresolvedPin` on a step's settings; none of the new exports is re-exported.
- 9af2e0c: `RegistryQadamsRequestQuery` accepts a prerelease platform version as `release` (`2.1.0-main.5`), so `GET /v1/qadams/registry` — the builder's version list — answers images built from `main` instead of failing with 400 (#798). `ListQadamsRequestQuery` validates `release` the same way; that endpoint still refuses any `release` as deprecated.
- 47c9525: Update third-party dependencies (Renovate).
- Updated dependencies [66d8bad]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
  - @aiqadam/shared@0.157.0
