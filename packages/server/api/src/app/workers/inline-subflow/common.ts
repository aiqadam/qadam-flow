export const INLINE_DEPTH_LIMIT = 50

export function validateInlineDepth(depth: number | undefined): void {
    if ((depth ?? 0) >= INLINE_DEPTH_LIMIT) {
        throw new Error('Inline subflow depth limit exceeded')
    }
}

export type InlineSubflowParams = {
    flowId: string
    payload: unknown
    parentRunId?: string
    failParentOnFailure?: boolean
    versionId?: string
    callbackUrl?: string
    inlineDepth?: number
}

export type InlineSubflowResult = {
    ok: boolean
    data?: {
        status: string
        data?: unknown
        runId: string
        childStatus: string
    }
    error?: string
}
