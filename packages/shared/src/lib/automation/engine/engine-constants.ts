import { FlowVersionState } from '../flows/flow-version'

export const DEFAULT_MCP_DATA = {
    flowId: 'mcp-flow-id',
    flowVersionId: 'mcp-flow-version-id',
    flowVersionState: FlowVersionState.LOCKED,
    flowRunId: 'mcp-flow-run-id',
    triggerQadamName: 'mcp-trigger-qadam-name',
}

/**
 * The engine has to put *something* in `flowRunId` for an execution that is not a flow run — an
 * MCP tool call, a property resolution, a trigger hook — and these are those placeholders
 * (`packages/server/engine/src/lib/handler/context/engine-constants.ts`). Anything keyed by run id
 * has to treat them as "no run": one fixed string is shared by every such execution on the
 * deployment, across every project, and it never goes away. They live here rather than in the
 * engine so a consumer cannot key on a copy of the literal that later drifts.
 */
export const DEFAULT_EXECUTE_PROPERTY_RUN_ID = 'execute-property'

export const DEFAULT_TRIGGER_EXECUTION_RUN_ID = 'execute-trigger'

export const SYNTHETIC_FLOW_RUN_IDS = [
    DEFAULT_MCP_DATA.flowRunId,
    DEFAULT_EXECUTE_PROPERTY_RUN_ID,
    DEFAULT_TRIGGER_EXECUTION_RUN_ID,
]

/**
 * Matched with `includes` against the first argument of a redirected `console.error` in the engine
 * (`worker-socket.ts`). Entries are prefixes on purpose: the line this exists for is
 * `'[HttpClient#(sanitized error message)] Request failed:'`, and the previous entry
 * `'HttpClient#sendRequest'` matched no line any code emits — so nothing was ever redacted, and the
 * full request body of every failing qadam request reached engine stderr. `packages/qadams/common`
 * asserts the emitted string against this list, because writing that test from this constant rather
 * than from the real line is what let the two drift apart unnoticed.
 */
export const ERROR_MESSAGES_TO_REDACT = [
    'HttpClient#',
]