import { FlowActionType, FlowRetryStrategy, GenericStepOutput, McpServerType, McpToolResult, ProjectScopedMcpServer, StepOutputStatus } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetOneOrThrow, mockRetry, mockGetOnePopulatedOrThrow } = vi.hoisted(() => ({
    mockGetOneOrThrow: vi.fn(),
    mockRetry: vi.fn(),
    mockGetOnePopulatedOrThrow: vi.fn(),
}))

vi.mock('../../../../src/app/flows/flow-run/flow-run-service', () => ({
    flowRunService: vi.fn(() => ({
        getOneOrThrow: mockGetOneOrThrow,
        retry: mockRetry,
        getOnePopulatedOrThrow: mockGetOnePopulatedOrThrow,
    })),
    isOutsideRetentionWindow: vi.fn(() => false),
}))

import { apRetryRunTool } from '../../../../src/app/mcp/tools/ap-retry-run'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: null } as unknown as ProjectScopedMcpServer

// #485 review finding 1: `ap_retry_run` is the one `formatRunResult` caller left without
// `structuredContent` — a pure fidelity loss for a step output over the 5000-char preview cap,
// since nothing else on this tool's response carries the untruncated value. Nothing failed if
// `buildRunStructuredContent` was dropped from `ap-retry-run.ts` before this test existed.
describe('ap_retry_run — structuredContent carries the untruncated step output the capped prose does not (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOneOrThrow.mockResolvedValue({ id: 'run-1', status: 'FAILED' })
        mockRetry.mockResolvedValue({ id: 'run-2' })
    })

    it('caps the prose preview but keeps the full output in structuredContent', async () => {
        const hugeOutput = 'z'.repeat(6001)
        const stepOutput = GenericStepOutput.create<FlowActionType.PIECE, unknown>({
            input: {},
            type: FlowActionType.PIECE,
            status: StepOutputStatus.SUCCEEDED,
        }).setOutput(hugeOutput)
        mockGetOnePopulatedOrThrow.mockResolvedValue({
            id: 'run-2',
            flowId: 'flow-1',
            status: 'SUCCEEDED',
            environment: 'PRODUCTION',
            created: '2024-01-01T00:00:00.000Z',
            startTime: '2024-01-01T00:00:00.000Z',
            finishTime: '2024-01-01T00:00:01.000Z',
            steps: { step_1: stepOutput },
        })

        const result: McpToolResult = await apRetryRunTool(mcp, log).execute({ flowRunId: 'run-1', strategy: FlowRetryStrategy.FROM_FAILED_STEP })

        const text = (result.content?.[0] as { text: string }).text
        expect(text).toContain('... (truncated)')
        expect(text).not.toContain(hugeOutput)

        const structured = result.structuredContent as { steps: Array<{ name: string, output: unknown }> }
        expect(structured).toBeDefined()
        expect(structured.steps.find(s => s.name === 'step_1')?.output).toBe(hugeOutput)
    })
})
