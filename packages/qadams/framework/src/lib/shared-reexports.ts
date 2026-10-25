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
// a semver promise to external qadam authors for types nobody outside their own defining qadam
// needs, so every one of them that is TYPE-ONLY (erased by `tsc`, no runtime existence) was removed
// from this list; `core/tables` and `community/ai` import those directly from `@aiqadam/shared` as
// `import type` instead (exempted from the lint ban in packages/qadams/eslint.config.mjs,
// `@aiqadam/shared` added only as a devDependency — never shipped, since nothing of it survives
// compilation).
//
// The single-qadam symbols that compile to a runtime value (an `enum` used as a value, a function,
// a plain `const`) could NOT be narrowed the same way and still stay here: `@aiqadam/shared` is
// private and unpublished (#799 — it exists specifically because a published package cannot depend
// on it), and `core/tables`, `community/ai` and `core/subflows` each publish standalone to npm
// (`tools/scripts/utils/qadam-publish-paths.ts`'s `OFFICIAL_QADAM_ROOTS` covers both `core` and
// `community`). A real runtime dependency on `shared` would resolve locally in this workspace and
// then 404 for anyone who installs the published qadam, exactly the failure #799 exists to prevent
// for the framework itself. Several of these are also genuine shared business logic the platform
// server calls too (`isValidAwsRegion`, `buildAuthHeaders`, `mcpToolNameUtils`,
// `normalizeToolOutputToExecuteResponse`) — qadam-local copies would risk drifting from the
// server's behaviour independently of this narrowing question. Removing these fully needs the same
// bundling `stagePackageForPublish` already does for the framework (`BUNDLED_PRIVATE_DEPENDENCIES`
// in `tools/scripts/utils/stage-package-for-publish.ts`), extended to cover qadam publishing, which
// is a separate, cross-cutting change — left as a follow-up rather than attempted here.

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

// The tables DTOs that are genuine runtime values for `core/tables` (an enum used as a value, or a
// plain constant) — see the file header. Everything else tables imported here (the request/response
// DTOs, which `tables` only ever uses as types) moved to a qadam-local `import type` (#959).
export {
  FieldType,
  FilterOperator,
  StaticDropdownEmptyOption,
  TableWebhookEventType,
} from '@aiqadam/shared'

// `McpProperty`/`McpPropertyType` stay: both `ai` and `mcp` import them, so they are genuinely
// shared qadam-facing API, unlike the single-qadam DTOs discussed above (#959).
export {
  McpProperty,
  McpPropertyType,
} from '@aiqadam/shared'

// The agent/MCP symbols that are genuine runtime values for `community/ai` — see the file header.
// The rest of the original block (AgentFlowTool, AgentKnowledgeBaseTool, AgentMcpTool,
// AgentOutputField, AgentStepBlock, AgentTool, MarkdownContentBlock, McpTrigger,
// ToolCallContentBlock — all zod-schema/type pairs `ai` only ever consumes as types) moved to a
// qadam-local `import type` (#959).
export {
  AgentOutputFieldType,
  AgentQadamProps,
  AgentTaskStatus,
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

// `AgentProviderModel`/`AgentResult`/`ExecuteToolResponse`/`ToolCallBase` (pure types, no runtime
// counterpart at all) and the AI-provider config types below moved to a qadam-local `import type`
// in `community/ai` (#959); only the runtime-value AI-provider symbols stay.
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
