// Every `@aiqadam/shared` symbol a qadam needs is re-exported here, so qadams import only
// `@aiqadam/qadams-framework` and `@aiqadam/qadams-common` (ADR-0001; the lint ban lives in
// packages/qadams/eslint.config.mjs). `shared` is the server/web DTO library and is going private
// (#799): at publish time the framework will bundle what this list names, so the list is the
// framework's public contract for these symbols and only grows deliberately. The names are the
// census of what qadams imported from `shared` when the ban landed (#786); a qadam that needs
// another one adds it here rather than importing `shared`.
//
// Narrowed before 1.0.0, in part (#959): the original 104-symbol census (#813) included
// platform-internal DTOs used by exactly one core/community qadam — tables request/record types,
// agent/MCP/AI-provider types, and subflow headers. Shipping those as framework exports makes them
// a semver promise to external qadam authors for symbols nobody outside their own defining qadam
// needs, so the 28 that its owner only ever CONSUMES AS A TYPE were removed from this list;
// `core/tables` and `community/ai` import those directly from `@aiqadam/shared` as `import type`
// instead (allowed for exactly those two qadams by the lint ban in packages/qadams/eslint.config.mjs,
// `@aiqadam/shared` added only as a devDependency). This is "type-only" in the consumer sense, not
// in `shared`: many of the removed names are zod schemas or enums there, so removing them does drop
// value exports external authors could call (e.g. `Table.parse`). That is the intended narrowing.
//
// What is removed is bounded by the qadam's PUBLISHED declarations, not only by its JavaScript.
// `tsc` erases an `import type` from `.js`, but not from `.d.ts`; a type that appears in an
// exported signature leaves `import type ... from '@aiqadam/shared'` in the shipped declaration,
// and `stagePackageForPublish`'s `assertNoPrivateDependencies` rejects that at publish time. The
// seven symbols that would do so stay re-exported here: `Field`, `Filter` and `PopulatedRecord`
// for `core/tables`; `AgentResult`, `AgentTool`, `AgentOutputField` and `AgentFlowTool` for
// `community/ai`. Everything re-pointed at `shared` is absent from both qadams' emitted `.d.ts`.
//
// The list went from 111 exported names (the 104 census plus 7 auth-value types no qadam names) to
// 83 (76 census plus the same 7): 28 removed.
//
// The other single-qadam symbols that compile to a runtime value (an `enum` used as a value, a
// function, a plain `const`, a zod schema used in code) could NOT be narrowed the same way and
// still stay here: `@aiqadam/shared` is private and unpublished (#799 — it exists specifically
// because a published package cannot depend on it), and `core/tables`, `community/ai` and
// `core/subflows` each publish standalone to npm (`tools/scripts/utils/qadam-publish-paths.ts`'s
// `OFFICIAL_QADAM_ROOTS` covers both `core` and `community`). A real runtime dependency on `shared`
// would resolve locally in this workspace and then 404 for anyone who installs the published qadam,
// exactly the failure #799 exists to prevent for the framework itself. Several of these are also
// genuine shared business logic the platform server calls too (`isValidAwsRegion`,
// `buildAuthHeaders`, `mcpToolNameUtils`, `normalizeToolOutputToExecuteResponse`) — qadam-local
// copies would risk drifting from the server's behaviour independently of this narrowing question.
// Removing these fully needs the same bundling `stagePackageForPublish` already does for the
// framework (`BUNDLED_PRIVATE_DEPENDENCIES` in
// `tools/scripts/utils/stage-package-for-publish.ts`), extended to cover qadam publishing, which is
// a separate, cross-cutting change — left as a follow-up rather than attempted here.

export {
  apId,
  assertNotNullOrUndefined,
  camelCase,
  chunk,
  isEmpty,
  isNil,
  isNotUndefined,
  isString,
  kebabCase,
  pickBy,
  SeekPage,
  spreadIfDefined,
  startCase,
  tryCatch,
  tryCatchSync,
  unique,
} from '@aiqadam/shared'

export {
  AppConnectionType,
  ExecutionType,
  MarkdownVariant,
  OAuth2GrantType,
  QadamCategory,
  StopResponse,
  WebhookHandshakeStrategy,
} from '@aiqadam/shared'

// `PopulatedFlow` is multi-use (`ai` + `subflows`) so it stays a real framework export; the rest
// of this block is forms-only but was not in #959's narrowing scope (tables/ai/mcp/subflows DTOs
// only — see the file header). The subflow headers and `SYNTHETIC_FLOW_RUN_IDS` are genuine
// single-qadam runtime values (header names set on real HTTP requests, a constant `shared`'s own
// source warns must never be duplicated) that stay here for the reason above.
export {
  ChatFormResponse,
  createKeyForFormInput,
  FAIL_PARENT_ON_FAILURE_HEADER,
  FileResponseInterface,
  FlowStatus,
  FlowTriggerType,
  HumanInputFormResult,
  HumanInputFormResultTypes,
  JOIN_WAITPOINT_MAX_SLOTS,
  JoinFailurePolicy,
  JoinResult,
  PARENT_RUN_ID_HEADER,
  PARENT_RUN_LOCALE_HEADER,
  PopulatedFlow,
  RAW_PAYLOAD_HEADER,
  SYNTHETIC_FLOW_RUN_IDS,
  USE_DRAFT_QUERY_PARAM_NAME,
} from '@aiqadam/shared'

// The tables DTOs that stay: genuine runtime values for `core/tables` (an enum used as a value, or
// a plain constant), plus the three that reach its published `.d.ts` (`Field`, `Filter`,
// `PopulatedRecord` — see the file header). Everything else tables imported here (the request and
// response DTOs, which `tables` only ever uses as types and never exports) moved to a qadam-local
// `import type` (#959).
export {
  Field,
  FieldType,
  Filter,
  FilterOperator,
  PopulatedRecord,
  StaticDropdownEmptyOption,
  TableWebhookEventType,
} from '@aiqadam/shared'

// `McpProperty`/`McpPropertyType` stay: both `ai` and `mcp` import them, so they are genuinely
// shared qadam-facing API, unlike the single-qadam DTOs discussed above (#959).
export {
  McpProperty,
  McpPropertyType,
} from '@aiqadam/shared'

// The agent/MCP symbols that stay for `community/ai`: genuine runtime values, plus the four that
// reach its published `.d.ts` (`AgentResult`, `AgentTool`, `AgentOutputField`, `AgentFlowTool` —
// see the file header). The rest of the original block (AgentKnowledgeBaseTool, AgentMcpTool,
// AgentStepBlock, MarkdownContentBlock, McpTrigger, ExecuteToolResponse, ToolCallBase,
// ToolCallContentBlock — all zod-schema/type pairs `ai` only ever consumes as types and never
// exports) moved to a qadam-local `import type` (#959).
export {
  AgentFlowTool,
  AgentOutputField,
  AgentOutputFieldType,
  AgentQadamProps,
  AgentTaskStatus,
  AgentTool,
  AgentToolType,
  buildAuthHeaders,
  ContentBlockType,
  ExecutionToolStatus,
  KnowledgeBaseSourceType,
  McpProtocol,
  mcpToolNameUtils,
  normalizeToolOutputToExecuteResponse,
  TASK_COMPLETION_TOOL_NAME,
  ToolCallStatus,
  ToolCallType,
} from '@aiqadam/shared'

// `AgentResult` is in the same published-`.d.ts` set as the value exports above, but it is a pure
// type in `shared` with no runtime counterpart, so it belongs in a type-only export.
export type { AgentResult } from '@aiqadam/shared'

// Not in the import census: no qadam names these. They are what `AppConnectionValueForAuthProperty`
// resolves `context.auth` to, so they sit in the inferred type of any action or trigger with auth.
// A qadam no longer depends on `shared` (#799), so its declaration emit can only name them through
// the framework; without these exports `tsc` fails with TS2742 (azure-devops, bitly, gmail, mautic).
export type {
  AppConnectionValue,
  BasicAuthConnectionValue,
  CustomAuthConnectionValue,
  NoAuthConnectionValue,
  OAuth2ConnectionValueWithApp,
  PlatformOAuth2ConnectionValue,
  SecretTextConnectionValue,
} from '@aiqadam/shared'

// `AgentProviderModel`/`ExecuteToolResponse`/`ToolCallBase` (pure types, no runtime counterpart at
// all) and the AI-provider config types below moved to a qadam-local `import type` in
// `community/ai` (#959); only the runtime-value AI-provider symbols stay. `AgentResult` also
// stays, but as the type-only export above, because `ai`'s published `.d.ts` names it.
export {
  AIProviderName,
  getEffectiveProviderAndModel,
  INVALID_AWS_REGION_MESSAGE,
  INVALID_AZURE_RESOURCE_NAME_MESSAGE,
  isValidAwsRegion,
  isValidAzureResourceName,
  mergeOpenAICompatibleExtraBody,
  OpenAICompatibleProviderConfig,
  splitCloudflareGatewayModelId,
} from '@aiqadam/shared'
