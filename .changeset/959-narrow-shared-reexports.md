---
"@aiqadam/qadams-framework": minor
---

Narrow the qadam-facing `@aiqadam/shared` re-export surface before `1.0.0` (#959): remove the single-qadam, type-only DTOs that `core/tables` and `community/ai` imported only for their own request/response and agent/MCP/AI-provider types (`CreateRecordsRequest`, `Field`, `Table`, `AgentTool`, `AIProviderModel`, and others — see `packages/qadams/framework/src/lib/shared-reexports.ts`). They were a semver promise to external qadam authors for types nobody outside their own defining qadam needs. The single-qadam symbols that compile to a runtime value (enums used as values, functions, constants — e.g. `FieldType`, `AIProviderName`, the subflow headers) are unaffected and stay exported, because `@aiqadam/shared` is private/unpublished and cannot be a real runtime dependency of a standalone-published qadam.
