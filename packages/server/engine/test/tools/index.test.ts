import { PropertyType } from '@aiqadam/qadams-framework'
import { AgentToolType, DEFAULT_MCP_DATA, ExecutionToolStatus, RunEnvironment } from '@aiqadam/shared'
import { LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
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
            insideConcurrentIteration: false,
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
            insideConcurrentIteration: false,
            tools: [buildTool('send_channel_message')],
            model: {} as LanguageModel,
        })

        const result = await tools.tool_1.execute!({ instruction: 'do the thing' }, {} as never)

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(result.output).toEqual({ ok: true })
    })

    // #643: the worker holds `resolveInlineFlow` to the job's own run, which the MCP placeholder run
    // id is not, so the tool's step has to run under its parent step's real run.
    it('runs the tool\'s step under the parent step\'s real run, not the MCP placeholder', async () => {
        mockGetQadamAndActionOrThrow.mockReset()
        mockGetQadamAndActionOrThrow.mockResolvedValue({ qadamAction: EMPTY_PROPS_ACTION })
        mockHandle.mockReset()
        mockHandle.mockResolvedValue({ steps: { callFlow: { output: {}, status: 'SUCCEEDED' } } })

        const tools = await agentTools.tools({
            engineConstants: generateMockEngineConstants({ flowRunId: 'parent-run-id', runEnvironment: RunEnvironment.PRODUCTION }),
            insideConcurrentIteration: false,
            tools: [buildTool('callFlow')],
            model: {} as LanguageModel,
        })
        await tools.tool_1.execute!({ instruction: 'call it' }, {} as never)

        const constants = mockHandle.mock.calls[0][0].constants
        expect(constants.flowRunId).toBe('parent-run-id')
        expect(constants.flowRunId).not.toBe(DEFAULT_MCP_DATA.flowRunId)
        expect(constants.runEnvironment).toBe(RunEnvironment.PRODUCTION)
        expect(constants.isAgentToolCall).toBe(true)
    })
})

// Find Records' shape: one required prop and two optional ones. Every extraction call below goes
// through the real AI SDK `generateText` + `Output.object`, so the strict-schema rejection that
// OpenAI-compatible models hit in production is what the mock model's text actually triggers.
const FIND_RECORDS_LIKE_ACTION = {
    description: 'find records',
    props: {
        table_id: { type: PropertyType.SHORT_TEXT, displayName: 'Table', required: true },
        limit: { type: PropertyType.NUMBER, displayName: 'Limit', required: false },
        record_ids: { type: PropertyType.ARRAY, displayName: 'Record IDs', required: false },
    },
}

function textResult(text: string) {
    return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
    }
}

async function runFindRecordsTool(model: MockLanguageModelV3) {
    mockGetQadamAndActionOrThrow.mockReset()
    mockGetQadamAndActionOrThrow.mockResolvedValue({ qadamAction: FIND_RECORDS_LIKE_ACTION })
    mockHandle.mockReset()
    mockHandle.mockResolvedValue({
        steps: { find_records: { output: [{ id: 'r1' }], status: 'SUCCEEDED' } },
    })
    const tools = await agentTools.tools({
        engineConstants: generateMockEngineConstants(),
        insideConcurrentIteration: false,
        tools: [buildTool('find_records')],
        model,
    })
    return tools.tool_1.execute!({ instruction: 'how many letters are there?' }, {} as never)
}

// `MockLanguageModelV3`'s array form reads `doGenerate[calls.length]` after pushing the call, so
// its first answer is the array's second entry; index by call count ourselves instead.
function sequenceModel(responses: ReturnType<typeof textResult>[]): MockLanguageModelV3 {
    const model: MockLanguageModelV3 = new MockLanguageModelV3({
        doGenerate: async () => responses[model.doGenerateCalls.length - 1],
    })
    return model
}

function promptText({ model, callIndex }: { model: MockLanguageModelV3, callIndex: number }): string {
    return JSON.stringify(model.doGenerateCalls[callIndex].prompt)
}

describe('agentTools.tools — property extraction', () => {
    it('accepts a response that omits optional keys instead of failing the whole tool call', async () => {
        const model = sequenceModel([textResult('{"table_id":"letters"}')])

        const result = await runFindRecordsTool(model)

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(result.resolvedInput).toMatchObject({ table_id: 'letters' })
        expect(mockHandle.mock.calls[0][0].action.settings.input).toEqual({ table_id: 'letters' })
        expect(model.doGenerateCalls).toHaveLength(1)
    })

    it('never lets a nested __proto__ key replace the prototype of a value passed to the action', async () => {
        const action = {
            description: 'send payload',
            props: { payload: { type: PropertyType.OBJECT, displayName: 'Payload', required: true } },
        }
        mockGetQadamAndActionOrThrow.mockReset()
        mockGetQadamAndActionOrThrow.mockResolvedValue({ qadamAction: action })
        mockHandle.mockReset()
        mockHandle.mockResolvedValue({ steps: { send_payload: { output: {}, status: 'SUCCEEDED' } } })
        const tools = await agentTools.tools({
            engineConstants: generateMockEngineConstants(),
            insideConcurrentIteration: false,
            tools: [buildTool('send_payload')],
            model: sequenceModel([textResult('```json\n{"payload":{"name":"a","__proto__":{"isAdmin":true}}}\n```')]),
        })

        await tools.tool_1.execute!({ instruction: 'send it' }, {} as never)

        const payload = mockHandle.mock.calls[0][0].action.settings.input.payload
        expect(payload).toEqual({ name: 'a' })
        expect(Object.getPrototypeOf(payload)).toBe(Object.prototype)
        expect(payload.isAdmin).toBeUndefined()
    })

    it('drops keys outside the requested properties and reads JSON wrapped in reasoning and a code fence', async () => {
        const model = sequenceModel([textResult('<think>the table is letters</think>\n```json\n{"table_id":"letters","limit":null,"sort":"desc"}\n```')])

        const result = await runFindRecordsTool(model)

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(mockHandle.mock.calls[0][0].action.settings.input).toEqual({ table_id: 'letters', limit: null })
    })

    it('retries once with the validation errors when a required key is missing', async () => {
        const model = sequenceModel([textResult('{"limit":10}'), textResult('{"table_id":"letters","limit":10}')])

        const result = await runFindRecordsTool(model)

        expect(result.status).toBe(ExecutionToolStatus.SUCCESS)
        expect(mockHandle.mock.calls[0][0].action.settings.input).toEqual({ table_id: 'letters', limit: 10 })
        expect(model.doGenerateCalls).toHaveLength(2)
        const retryPrompt = promptText({ model, callIndex: 1 })
        expect(retryPrompt).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED')
        expect(retryPrompt).toContain('VALIDATION ERRORS')
        expect(retryPrompt).toContain('→ at table_id')
    })

    it('fails with the validation errors when the retry is valid JSON that still breaks the schema', async () => {
        const model = sequenceModel([textResult('{"limit":10}'), textResult('{"limit":"ten"}')])

        const result = await runFindRecordsTool(model)

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('→ at table_id')
        expect(result.errorMessage).toContain('→ at limit')
        expect(mockHandle).not.toHaveBeenCalled()
    })

    it('fails with a readable reason when the retry is not JSON at all', async () => {
        const model = sequenceModel([textResult('{"limit":"ten"}'), textResult('not json at all')])

        const result = await runFindRecordsTool(model)

        expect(result.status).toBe(ExecutionToolStatus.FAILED)
        expect(result.errorMessage).toContain('the response is not a JSON object')
        expect(mockHandle).not.toHaveBeenCalled()
    })

    it('shows the model the JSON schema and asks for null instead of skipping optional keys', async () => {
        const model = sequenceModel([textResult('{"table_id":"letters","limit":null,"record_ids":null}')])

        await runFindRecordsTool(model)

        const prompt = promptText({ model, callIndex: 0 })
        expect(prompt).toContain('JSON SCHEMA')
        expect(prompt).toContain('\\"required\\":[\\"table_id\\",\\"limit\\",\\"record_ids\\"]')
        expect(prompt).not.toContain('Skip if no information is available')
    })
})
