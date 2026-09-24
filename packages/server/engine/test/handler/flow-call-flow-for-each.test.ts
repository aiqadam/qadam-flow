import { FlowActionType, FlowRunStatus, GenericStepOutput, StepOutputStatus } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { waitpointClient } from '../../src/lib/qadam-context/waitpoint-client'
import { mockHttpServer } from './mock-http-server'
import { buildQadamAction, generateMockEngineConstants } from './test-helper'

// #374: `callFlowForEach` starts one queue-mode child per item, each answering its own join slot,
// and pauses once; on resume it reports every answer, or fails when the policy was not met.
describe('Call Flow for Each Item', () => {
    let mockServer: Awaited<ReturnType<typeof mockHttpServer.start>>

    beforeAll(async () => {
        mockServer = await mockHttpServer.start()
    })

    afterAll(async () => {
        await mockServer.close()
    })

    beforeEach(() => {
        vi.spyOn(EngineConstants.prototype, 'devQadams', 'get').mockReturnValue([])
        mockServer.requests.length = 0
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const fanOut = ({ items, failurePolicy = 'ALL_SETTLED', quorum }: { items: unknown[], failurePolicy?: string, quorum?: number }) => buildQadamAction({
        name: 'fan_out',
        qadamName: '@aiqadam/qadam-subflows',
        actionName: 'callFlowForEach',
        input: {
            flow: { externalId: 'child', exampleData: {} },
            items,
            failurePolicy,
            ...(quorum === undefined ? {} : { quorum }),
        },
    })

    const constants = (overrides?: Partial<EngineConstants>): EngineConstants => generateMockEngineConstants({
        stepNames: ['fan_out'],
        internalApiUrl: `${mockServer.baseUrl}/`,
        ...overrides,
    })

    const stubJoin = (count: number, options?: { dispatchedSlots?: number[], slotPath?: string }): void => {
        vi.spyOn(waitpointClient, 'create').mockResolvedValue({
            id: 'join',
            resumeUrl: `${mockServer.baseUrl}/v1/flow-runs/run/waitpoints/join`,
            slotResumeUrls: Array.from({ length: count }, (_, index) => `${mockServer.baseUrl}${options?.slotPath ?? '/slots/'}${index}`),
            dispatchedSlots: options?.dispatchedSlots,
        })
    }

    it('starts one child per item with its own slot as callback, and pauses once on a join', async () => {
        stubJoin(3)

        const result = await flowExecutor.execute({ action: fanOut({ items: [{ n: 0 }, { n: 1 }, { n: 2 }] }), executionState: FlowExecutorContext.empty(), constants: constants() })

        expect(result.verdict.status).toBe(FlowRunStatus.PAUSED)
        expect(waitpointClient.create).toHaveBeenCalledTimes(1)
        expect(waitpointClient.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'WEBHOOK', internal: true, stepName: 'fan_out', join: { slots: 3, failurePolicy: 'ALL_SETTLED', quorum: undefined, timeoutSeconds: undefined } }))
        const dispatched = mockServer.requests.filter((request) => request.path === '/v1/webhooks/child-flow')
        expect(dispatched.map((request) => request.body)).toEqual(expect.arrayContaining([
            { data: { n: 0 }, callbackUrl: `${mockServer.baseUrl}/slots/0` },
            { data: { n: 1 }, callbackUrl: `${mockServer.baseUrl}/slots/1` },
            { data: { n: 2 }, callbackUrl: `${mockServer.baseUrl}/slots/2` },
        ]))
        expect(dispatched.every((request) => request.headers['ap-fail-parent-on-failure'] === 'true')).toBe(true)
    }, 20000)

    it('answers the slot of a child that could not be started, so the join does not wait for it', async () => {
        stubJoin(2)

        await flowExecutor.execute({ action: fanOut({ items: [{ fail: true }, { n: 1 }] }), executionState: FlowExecutorContext.empty(), constants: constants() })

        const slotAnswers = mockServer.requests.filter((request) => request.path.startsWith('/slots/'))
        expect(slotAnswers).toHaveLength(1)
        expect(slotAnswers[0]).toMatchObject({ path: '/slots/0', body: { status: 'error' } })
    }, 20000)

    // A step run again — its engine job retried — gets its own join back.
    it('does not start a child again for a slot that already has one', async () => {
        stubJoin(3, { dispatchedSlots: [0, 2] })

        const result = await flowExecutor.execute({ action: fanOut({ items: [{ n: 0 }, { n: 1 }, { n: 2 }] }), executionState: FlowExecutorContext.empty(), constants: constants() })

        expect(result.verdict.status).toBe(FlowRunStatus.PAUSED)
        const dispatched = mockServer.requests.filter((request) => request.path === '/v1/webhooks/child-flow')
        expect(dispatched.map((request) => request.body)).toEqual([{ data: { n: 1 }, callbackUrl: `${mockServer.baseUrl}/slots/1` }])
    }, 20000)

    it('still pauses when the slot of a child that could not start cannot be answered either', async () => {
        stubJoin(2, { slotPath: '/slots-down/' })

        const result = await flowExecutor.execute({ action: fanOut({ items: [{ fail: true }, { n: 1 }] }), executionState: FlowExecutorContext.empty(), constants: constants() })

        expect(result.verdict.status).toBe(FlowRunStatus.PAUSED)
        expect(mockServer.requests.filter((request) => request.path === '/v1/webhooks/child-flow')).toHaveLength(2)
    }, 60000)

    it('refuses more items than a join holds, and a quorum it could never reach, before creating anything', async () => {
        stubJoin(0)

        const tooMany = await flowExecutor.execute({ action: fanOut({ items: Array.from({ length: 501 }, (_, index) => index) }), executionState: FlowExecutorContext.empty(), constants: constants() })
        const badQuorum = await flowExecutor.execute({ action: fanOut({ items: [1, 2], failurePolicy: 'QUORUM', quorum: 3 }), executionState: FlowExecutorContext.empty(), constants: constants() })

        expect(tooMany.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(badQuorum.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(waitpointClient.create).not.toHaveBeenCalled()
    }, 20000)

    it('on resume outputs every answer in item order, and fails when the policy was not met', async () => {
        const results = [{ status: 'success', data: { n: 0 } }, { status: 'error', data: { message: 'boom' } }]
        const settled = await resume({ body: { status: 'success', data: { results, succeeded: 1, failed: 1, timedOut: 0 } } })
        const notMet = await resume({ body: { status: 'error', data: { results, succeeded: 1, failed: 1, timedOut: 0 } } })

        expect(settled.verdict.status).toBe(FlowRunStatus.RUNNING)
        expect(settled.steps.fan_out?.output).toEqual({ results, succeeded: 1, failed: 1, timedOut: 0 })
        expect(notMet.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(notMet.verdict.status === FlowRunStatus.FAILED ? notMet.verdict.failedStep.message : '').toContain('did not meet the failure policy')
    }, 20000)

    const resume = async ({ body }: { body: unknown }): Promise<FlowExecutorContext> => {
        const paused = await FlowExecutorContext.empty().upsertStep('fan_out', GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.PAUSED, input: {} }))
        return flowExecutor.execute({ action: fanOut({ items: [{ n: 0 }, { n: 1 }] }), executionState: paused, constants: constants({ resumePayload: { body, headers: {}, queryParams: {} } }) })
    }
})
