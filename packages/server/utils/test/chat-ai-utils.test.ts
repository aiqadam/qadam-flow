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
