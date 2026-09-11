import { FlowVersionState } from '../flows/flow-version'

export const DEFAULT_MCP_DATA = {
    flowId: 'mcp-flow-id',
    flowVersionId: 'mcp-flow-version-id',
    flowVersionState: FlowVersionState.LOCKED,
    flowRunId: 'mcp-flow-run-id',
    triggerQadamName: 'mcp-trigger-qadam-name',
}

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