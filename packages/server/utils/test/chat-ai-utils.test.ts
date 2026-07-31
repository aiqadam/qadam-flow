import { PersistedChatPartType } from '@aiqadam/shared'
import { chatAiUtils, ContentPartLike } from '../src/chat-ai-utils'

const validBatchProgress = {
    label: 'Updating rows',
    total: 3,
    completed: 2,
    succeeded: 1,
    failed: 1,
    done: false,
    results: [
        { index: 0, success: true },
        { index: 1, success: false, error: 'boom' },
    ],
}

function buildContent(output: Record<string, unknown>): ContentPartLike[] {
    return [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'ap_execute_action', args: {} },
        { type: 'tool-result', toolCallId: 'call-1', output },
    ]
}

describe('chatAiUtils.buildStepParts — ap_execute_action batchProgress', () => {
    it('persists a BATCH_PROGRESS part for a fully valid batchProgress shape', () => {
        const parts = chatAiUtils.buildStepParts({ content: buildContent({ success: true, batchProgress: validBatchProgress }) })
        const batchPart = parts.find((part) => part.type === PersistedChatPartType.BATCH_PROGRESS)
        expect(batchPart).toEqual({ type: PersistedChatPartType.BATCH_PROGRESS, data: validBatchProgress })
    })

    it('drops the batchProgress part silently when the tool output has none', () => {
        const parts = chatAiUtils.buildStepParts({ content: buildContent({ success: true }) })
        expect(parts.find((part) => part.type === PersistedChatPartType.BATCH_PROGRESS)).toBeUndefined()
    })

    it.each([
        ['label', { ...validBatchProgress, label: 123 }],
        ['total', { ...validBatchProgress, total: '3' }],
        ['completed', { ...validBatchProgress, completed: '2' }],
        ['succeeded', { ...validBatchProgress, succeeded: null }],
        ['failed', { ...validBatchProgress, failed: undefined }],
        ['done', { ...validBatchProgress, done: 'false' }],
        ['results (not an array)', { ...validBatchProgress, results: {} }],
        ['results[n].index', { ...validBatchProgress, results: [{ index: 'zero', success: true }] }],
        ['results[n].success', { ...validBatchProgress, results: [{ index: 0, success: 'yes' }] }],
        ['results[n].error', { ...validBatchProgress, results: [{ index: 0, success: false, error: 42 }] }],
    ])('drops the batchProgress part when %s is malformed', (_field, malformed) => {
        const parts = chatAiUtils.buildStepParts({ content: buildContent({ success: true, batchProgress: malformed }) })
        expect(parts.find((part) => part.type === PersistedChatPartType.BATCH_PROGRESS)).toBeUndefined()
    })

    it('does not extract batchProgress for a different tool name', () => {
        const content: ContentPartLike[] = [
            { type: 'tool-call', toolCallId: 'call-2', toolName: 'ap_select_project', args: {} },
            { type: 'tool-result', toolCallId: 'call-2', output: { success: true, batchProgress: validBatchProgress } },
        ]
        const parts = chatAiUtils.buildStepParts({ content })
        expect(parts.find((part) => part.type === PersistedChatPartType.BATCH_PROGRESS)).toBeUndefined()
    })
})

// The status recorded here is what the next turn's transcript is rebuilt from, so getting it
// wrong is not cosmetic: a failed call recorded as COMPLETED replays to the model as "the tool
// worked and returned nothing", and it neither retries nor explains.
describe('chatAiUtils.buildStepParts — tool call status', () => {
    function toolCall(result: ContentPartLike | null): ContentPartLike[] {
        const call: ContentPartLike = { type: 'tool-call', toolCallId: 'call-1', toolName: 'ap_list_flows', input: {} }
        return result === null ? [call] : [call, result]
    }

    function statusOf(content: ContentPartLike[]): string | undefined {
        const part = chatAiUtils.buildStepParts({ content }).find((candidate) => candidate.type === PersistedChatPartType.TOOL_CALL)
        return part !== undefined && 'status' in part ? part.status : undefined
    }

    it('records a successful call as completed', () => {
        expect(statusOf(toolCall({ type: 'tool-result', toolCallId: 'call-1', output: { flows: [] } }))).toBe('completed')
    })

    // A `tool-error` part IS a result, so "any result means success" recorded every failure as
    // completed — the whole reason this case exists.
    it('records a tool-error result as an error, not as a completed call', () => {
        expect(statusOf(toolCall({ type: 'tool-error', toolCallId: 'call-1', output: 'boom' }))).toBe('error')
    })

    it('records a call with no result at all as an error', () => {
        expect(statusOf(toolCall(null))).toBe('error')
    })
})

// A gated call is stopped before it executes, so it has no result — and the status rules above would
// therefore record it as a failure. The next turn would tell the model the destructive action was
// attempted and failed, so it would apologise or retry rather than wait for the human the gate
// exists to ask.
describe('chatAiUtils.buildStepParts — a gated tool call', () => {
    const approvalRequest: ContentPartLike = {
        type: 'tool-approval-request',
        approvalId: 'approval-1',
        toolCall: { toolCallId: 'call-1', toolName: 'ap_delete_flow', input: { flowId: 'flow-1' } },
    }
    const gatedCall: ContentPartLike = { type: 'tool-call', toolCallId: 'call-1', toolName: 'ap_delete_flow', input: { flowId: 'flow-1' } }

    it('reads the call out of the nested `toolCall` the SDK puts it in', () => {
        const parts = chatAiUtils.buildStepParts({ content: [gatedCall, approvalRequest] })

        expect(parts).toEqual([{
            type: PersistedChatPartType.TOOL_APPROVAL_REQUEST,
            approvalId: 'approval-1',
            toolCallId: 'call-1',
            toolName: 'ap_delete_flow',
            input: { flowId: 'flow-1' },
        }])
    })

    // The measured order is call-then-request, but the two are enqueued from separate streams that
    // are merged, so nothing guarantees it. Deciding as the content is walked would silently record
    // the failed call again the day that order changed.
    it('suppresses the call whichever side of the approval request it arrives on', () => {
        const parts = chatAiUtils.buildStepParts({ content: [approvalRequest, gatedCall] })

        expect(parts.filter((part) => part.type === PersistedChatPartType.TOOL_CALL)).toEqual([])
    })

    it('leaves an ungated call in the same step alone', () => {
        const parts = chatAiUtils.buildStepParts({
            content: [
                { type: 'tool-call', toolCallId: 'call-2', toolName: 'ap_list_flows', input: {} },
                { type: 'tool-result', toolCallId: 'call-2', output: { flows: [] } },
                gatedCall,
                approvalRequest,
            ],
        })

        expect(parts.map((part) => part.type)).toEqual([
            PersistedChatPartType.TOOL_CALL,
            PersistedChatPartType.TOOL_APPROVAL_REQUEST,
        ])
    })
})
