import { FlowActionType, FlowTriggerType, GenericStepOutput, StepOutputStatus } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockFlowServiceUpdate = vi.fn()
const mockFlowServiceCreate = vi.fn()
const mockFlowServiceDelete = vi.fn()
const mockRunTest = vi.fn()
const mockGetOnePopulatedOrThrow = vi.fn()
const mockQadamGet = vi.fn()
const mockQadamGetOrThrow = vi.fn()
const mockProjectGetOneOrThrow = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        update: mockFlowServiceUpdate,
        create: mockFlowServiceCreate,
        delete: mockFlowServiceDelete,
    })),
}))

vi.mock('../../../../src/app/flows/flow-run/flow-run-service', () => ({
    flowRunService: vi.fn(() => ({
        test: mockRunTest,
        getOnePopulatedOrThrow: mockGetOnePopulatedOrThrow,
    })),
    isOutsideRetentionWindow: vi.fn(() => false),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: mockQadamGet,
        getOrThrow: mockQadamGetOrThrow,
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: mockProjectGetOneOrThrow,
    })),
}))

import { executeAdhocAction, executeFlowTest } from '../../../../src/app/mcp/tools/flow-run-utils'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

// One character short of a round number, so a boundary-off-by-one wouldn't hide behind it.
const HUGE_OUTPUT = 'y'.repeat(6001)

function trigger(): Record<string, unknown> {
    return {
        name: 'trigger',
        displayName: 'Select Trigger',
        valid: true,
        type: FlowTriggerType.EMPTY,
        settings: {},
    }
}

// #485 review: exactly one behaviour of the widened perimeter had a test before this file. Nothing
// failed if every `wrapUntrustedValue` call in `ap-setup-guide.ts` was deleted, or if
// `structuredContent` was dropped from `executeFlowTest`/`executeAdhocAction`, or if the truncation
// caps were changed to any value >= 1. These pin the two caps and prove `structuredContent` is what
// makes the cap harmless: the raw, untruncated value survives there even though the prose caps it.
describe('executeFlowTest — structuredContent carries the untruncated step output the capped prose does not (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('caps the prose preview at 5000 chars but structuredContent keeps the full 6001-char output', async () => {
        mockGetOnePopulated.mockResolvedValue({
            id: 'flow-1',
            version: { id: 'fv-1', displayName: 'Test Flow', trigger: trigger() },
        })
        mockRunTest.mockResolvedValue({ id: 'run-1' })
        const stepOutput = GenericStepOutput.create<FlowActionType.PIECE, unknown>({
            input: {},
            type: FlowActionType.PIECE,
            status: StepOutputStatus.SUCCEEDED,
        }).setOutput(HUGE_OUTPUT)
        mockGetOnePopulatedOrThrow.mockResolvedValue({
            id: 'run-1',
            flowId: 'flow-1',
            status: 'SUCCEEDED',
            environment: 'PRODUCTION',
            created: '2024-01-01T00:00:00.000Z',
            startTime: '2024-01-01T00:00:00.000Z',
            finishTime: '2024-01-01T00:00:01.000Z',
            steps: { step_1: stepOutput },
        })

        const result = await executeFlowTest({ flowId: 'flow-1', projectId: 'project-1', log })

        const text = (result.content?.[0] as { text: string }).text
        expect(text).toContain('... (truncated)')
        expect(text).not.toContain(HUGE_OUTPUT)

        const structured = result.structuredContent as { steps: Array<{ name: string, output: unknown }> }
        expect(structured).toBeDefined()
        const stepEntry = structured.steps.find(s => s.name === 'step_1')
        expect(stepEntry?.output).toBe(HUGE_OUTPUT)
    })
})

describe('executeAdhocAction — structuredContent carries the untruncated step output the capped prose does not (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockProjectGetOneOrThrow.mockResolvedValue({ id: 'project-1', platformId: 'platform-1' })
        mockQadamGet.mockResolvedValue({
            name: '@aiqadam/qadam-test',
            version: '1.0.0',
            auth: undefined,
            actions: {
                test_action: {
                    name: 'test_action',
                    displayName: 'Test Action',
                    props: {},
                    requireAuth: false,
                },
            },
            triggers: {},
        })
        mockQadamGetOrThrow.mockResolvedValue({
            actions: { test_action: { props: {} } },
        })
        mockFlowServiceCreate.mockResolvedValue({
            id: 'flow-adhoc-1',
            version: { id: 'fv-adhoc-1', trigger: trigger() },
        })
        mockFlowServiceUpdate.mockResolvedValue({
            id: 'flow-adhoc-1',
            version: { id: 'fv-adhoc-2', trigger: trigger() },
        })
        mockFlowServiceDelete.mockResolvedValue(undefined)
        mockRunTest.mockResolvedValue({ id: 'run-adhoc-1' })
    })

    it('caps the prose preview at 5000 chars but structuredContent keeps the full 6001-char output', async () => {
        const stepOutput = GenericStepOutput.create<FlowActionType.PIECE, unknown>({
            input: {},
            type: FlowActionType.PIECE,
            status: StepOutputStatus.SUCCEEDED,
        }).setOutput(HUGE_OUTPUT)
        mockGetOnePopulatedOrThrow.mockResolvedValue({
            id: 'run-adhoc-1',
            flowId: 'flow-adhoc-1',
            status: 'SUCCEEDED',
            environment: 'TESTING',
            created: '2024-01-01T00:00:00.000Z',
            startTime: '2024-01-01T00:00:00.000Z',
            finishTime: '2024-01-01T00:00:01.000Z',
            // `findUnusedName` on a trigger-only flow deterministically returns `step_1`.
            steps: { step_1: stepOutput },
        })

        const result = await executeAdhocAction({
            projectId: 'project-1',
            qadamName: '@aiqadam/qadam-test',
            actionName: 'test_action',
            log,
        })

        const text = (result.content?.[0] as { text: string }).text
        expect(text).toContain('... (truncated)')
        expect(text).not.toContain(HUGE_OUTPUT)

        const structured = result.structuredContent as { output: unknown, runStatus: string, stepStatus: string }
        expect(structured).toBeDefined()
        expect(structured.output).toBe(HUGE_OUTPUT)
        expect(structured.runStatus).toBe('SUCCEEDED')
        expect(structured.stepStatus).toBe(StepOutputStatus.SUCCEEDED)
    })
})
