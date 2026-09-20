import { AgentToolType, ExecutionToolStatus } from '@aiqadam/shared'
import { LanguageModel } from 'ai'
import { describe, expect, it, vi } from 'vitest'

const { mockGetQadamAndActionOrThrow } = vi.hoisted(() => ({
    mockGetQadamAndActionOrThrow: vi.fn(),
}))
vi.mock('../../src/lib/helper/qadam-loader', () => ({
    qadamLoader: { getQadamAndActionOrThrow: mockGetQadamAndActionOrThrow },
}))

const { mockHandle } = vi.hoisted(() => ({
    mockHandle: vi.fn(),
}))
vi.mock('../../src/lib/handler/flow-executor', () => ({
    flowExecutor: { getExecutorForAction: () => ({ handle: mockHandle }) },
}))

import { agentTools } from '../../src/lib/tools'
import { generateMockEngineConstants } from '../handler/test-helper'

// A qadam action with no props at all: `resolveProperties` only calls the AI SDK's `generateText`
// when a depth level has at least one property to fill, and `tsort.sortPropertiesByDependencies({})`
// produces no depth levels — so this reaches `execute()`'s guarded read with no AI SDK mock needed.
const EMPTY_PROPS_ACTION = { props: {}, description: 'no-op action' }

function buildTool(actionName: string) {
    return {
        type: AgentToolType.PIECE as const,
        toolName: 'tool_1',
        qadamMetadata: {
            qadamName: '@aiqadam/qadam-slack',
            qadamVersion: '1.0.0',
            actionName,
        },
    }
}

describe('agentTools.tools — execute()', () => {
    // Blocking finding: `const { output, errorMessage, status } = output.steps[operation.actionName]`
    // is a bare index. `operation.actionName` is qadam-author-controlled and `STEP_NAME_REGEX`
    // admits `constructor`, which resolves off `Object.prototype` (the `Object` constructor
    // function, truthy — not `undefined`) when the executor's own step map has no entry for it.
    // Destructuring a function yields `output: undefined, errorMessage: undefined,
    // status: undefined`, and `status !== FAILED` reports a fake `SUCCESS`. This must fail (status
    // `SUCCESS` with `output: undefined`, no error) on a bare index and pass (status `FAILED` with
    // a real error message) with `executionJournal.getOwnStep`.
    it('reports FAILED, not a fake SUCCESS, when the executor produces no step for an action named "constructor"', async () => {
        mockGetQadamAndActionOrThrow.mockReset()
        mockGetQadamAndActionOrThrow.mockResolvedValue({ qadamAction: EMPTY_PROPS_ACTION })
        mockHandle.mockReset()
        mockHandle.mockResolvedValue({ steps: {} })

        const tools = await agentTools.tools({
            engineConstants: generateMockEngineConstants(),
            tools: [buildTool('constructor')],
            model: {} as LanguageModel,
        })

        const result = await tools.tool_1.execute!({ instruction: 'do the thing' }, {} as never)

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('No step output found for action "constructor"')
        expect(result.output).toBeUndefined()
    })

    it('reports SUCCESS with the real step output for an ordinarily-named action', async () => {
        mockGetQadamAndActionOrThrow.mockReset()
        mockGetQadamAndActionOrThrow.mockResolvedValue({ qadamAction: EMPTY_PROPS_ACTION })
        mockHandle.mockReset()
        mockHandle.mockResolvedValue({
            steps: {
                send_channel_message: { output: { ok: true }, status: 'SUCCEEDED' },
            },
        })

        const tools = await agentTools.tools({
            engineConstants: generateMockEngineConstants(),
            tools: [buildTool('send_channel_message')],
            model: {} as LanguageModel,
        })

        const result = await tools.tool_1.execute!({ instruction: 'do the thing' }, {} as never)

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(result.output).toEqual({ ok: true })
    })
})
