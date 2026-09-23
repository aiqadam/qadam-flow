import { ErrorCode, McpServerType, McpToolResult, ProjectScopedMcpServer, QadamFlowError } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetOneOrThrow, mockRetry } = vi.hoisted(() => ({
    mockGetOneOrThrow: vi.fn(),
    mockRetry: vi.fn(),
}))

vi.mock('../../../../src/app/flows/flow-run/flow-run-service', () => ({
    flowRunService: vi.fn(() => ({
        getOneOrThrow: mockGetOneOrThrow,
        retry: mockRetry,
        getOnePopulatedOrThrow: vi.fn(),
    })),
    isOutsideRetentionWindow: vi.fn(() => false),
}))

import { apRetryRunTool } from '../../../../src/app/mcp/tools/ap-retry-run'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: null } as unknown as ProjectScopedMcpServer

// #505 review fix: a retry refused because the trigger's payload was redacted must reach the
// caller as an actionable message, not the generic "Failed to retry run" fallback mcpToolError
// gives an unrecognized error code.
describe('ap_retry_run — surfaces the redacted-trigger refusal message (#505 review fix)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneOrThrow.mockResolvedValue({ id: 'run-1', status: 'FAILED' })
    })

    it('shows the refusal message instead of a generic failure', async () => {
        const message = 'Can\'t retry run run-1: its trigger payload was not kept in the run log because logging was turned off for the trigger. Re-trigger the flow with a fresh event, or turn trigger logging back on for future runs before retrying.'
        mockRetry.mockRejectedValue(new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message))

        const result: McpToolResult = await apRetryRunTool(mcp, log).execute({ flowRunId: 'run-1', strategy: 'FROM_FAILED_STEP' })

        const text = (result.content?.[0] as { text: string }).text
        expect(result.isError).toBe(true)
        expect(text).toContain('trigger payload was not kept in the run log')
        expect(text).toContain('turn trigger logging back on')
        expect(text).not.toContain('Failed to retry run: VALIDATION')
    })
})
