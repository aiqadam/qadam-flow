/**
 * Join waitpoints (#374): one WEBHOOK waitpoint answered by N queue-mode children, each through its
 * own slot, resuming its run once with every answer in slot order.
 */
import { apId, CreateWaitpointResponse, ExecutionType, FlowRun, FlowRunStatus, FlowVersionState, JoinFailurePolicy, PrincipalType, RunEnvironment, StreamStepProgress } from '@aiqadam/shared'
import { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { Repository } from 'typeorm'
import { flowRunService } from '../../../../../src/app/flows/flow-run/flow-run-service'
import { joinWaitpointService } from '../../../../../src/app/flows/flow-run/waitpoint/join-waitpoint-service'
import { WaitpointSlotStatus, WaitpointStatus } from '../../../../../src/app/flows/flow-run/waitpoint/waitpoint-types'
import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'
import { generateMockToken } from '../../../../helpers/auth'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Join waitpoint', () => {
    it('hands back one slot URL per child, each with its own secret', async () => {
        const { run, engineToken, projectId } = await setupParent()

        const response = await createJoin({ engineToken, run, projectId, slots: 3, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })

        expect(response.statusCode).toBe(201)
        const body: CreateWaitpointResponse = response.json()
        expect(body.slotResumeUrls).toHaveLength(3)
        const slotIds = (body.slotResumeUrls ?? []).map((url) => new URL(url).pathname.split('/').pop())
        expect(new Set(slotIds).size).toBe(3)
        for (const url of body.slotResumeUrls ?? []) {
            expect(new URL(url).pathname).toMatch(new RegExp(`/v1/flow-runs/${run.id}/waitpoints/${body.id}/slots/[^/]+$`))
        }
        const slots = await db.find<{ projectId: string, status: string }>('waitpoint_slot', { waitpointId: body.id })
        expect(slots).toHaveLength(3)
        expect(slots.every((slot) => slot.projectId === projectId && slot.status === WaitpointSlotStatus.PENDING)).toBe(true)
    })

    it('refuses a join that is not a WEBHOOK waitpoint, or whose quorum exceeds its slots', async () => {
        const { run, engineToken, projectId } = await setupParent()

        const quorumTooLarge = await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.QUORUM, quorum: 3 })
        const delayJoin = await postWaitpoint({
            engineToken,
            payload: { flowRunId: run.id, projectId, stepName: 'fan_out', type: 'DELAY', version: 'V1', resumeDateTime: new Date(Date.now() + 60_000).toISOString(), join: { slots: 2, failurePolicy: 'ALL_SETTLED' } },
        })

        const timeoutTooLong = await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED, timeoutSeconds: 10 * 365 * 24 * 60 * 60 })

        expect(quorumTooLarge.statusCode).toBeGreaterThanOrEqual(400)
        expect(delayJoin.statusCode).toBeGreaterThanOrEqual(400)
        expect(timeoutTooLong.statusCode).toBeGreaterThanOrEqual(400)
        expect(await db.findOneBy('waitpoint', { flowRunId: run.id })).toBeNull()
    })

    it('refuses a second pending join on the same run, but hands a step its own join again', async () => {
        const { run, engineToken, projectId } = await setupParent()
        const first: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()

        const replay = await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })
        const second = await postWaitpoint({
            engineToken,
            payload: { flowRunId: run.id, projectId, stepName: 'another_fan_out', type: 'WEBHOOK', version: 'V1', internal: true, join: { slots: 2, failurePolicy: 'ALL_SETTLED' } },
        })

        expect(replay.statusCode).toBe(201)
        expect(replay.json().id).toBe(first.id)
        expect(replay.json().slotResumeUrls).toEqual(first.slotResumeUrls)
        expect(replay.json().dispatchedSlots).toEqual([])
        expect(second.statusCode).toBeGreaterThanOrEqual(400)
        expect(await db.find('waitpoint_slot', { flowRunId: run.id })).toHaveLength(2)
    })

    it('cannot be resumed through the plain waitpoint route, which every child could reach', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.PAUSED })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()

        const plain = await app.inject({ method: 'POST', url: `/api/v1/flow-runs/${run.id}/waitpoints/${join.id}`, payload: { status: 'success', data: 'forged' } })
        const plainSync = await app.inject({ method: 'POST', url: `/api/v1/flow-runs/${run.id}/waitpoints/${join.id}/sync`, payload: { status: 'success', data: 'forged' } })

        expect(plain.json().message).toContain('expired')
        expect(plainSync.statusCode).toBe(410)
        const waitpoint = await db.findOneBy<{ status: string }>('waitpoint', { id: join.id })
        expect(waitpoint?.status).toBe(WaitpointStatus.PENDING)
    })

    it('keeps the first answer to a slot, and refuses a slot id it never issued', async () => {
        const { run, engineToken, projectId } = await setupParent()
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const [first] = join.slotResumeUrls ?? []

        const answered = await answer({ url: first, body: { status: 'success', data: { value: 'first' } } })
        const duplicate = await answer({ url: first, body: { status: 'success', data: { value: 'second' } } })
        const forged = await answer({ url: first.replace(/[^/]+$/, apId()), body: { status: 'success', data: { value: 'forged' } } })

        expect(answered.json().message).toContain('recorded')
        expect(duplicate.json().message).toContain('expired')
        expect(forged.json().message).toContain('expired')
        const slots = await db.find<{ slotIndex: number, status: string, payload: string | null }>('waitpoint_slot', { waitpointId: join.id })
        const byIndex = [...slots].sort((a, b) => a.slotIndex - b.slotIndex)
        expect(byIndex.map((slot) => slot.status)).toEqual([WaitpointSlotStatus.SUCCEEDED, WaitpointSlotStatus.PENDING])
        expect(JSON.parse(byIndex[0].payload ?? 'null')).toEqual({ value: 'first' })
    })

    // The fast-child race: every child can answer before the parent has even reported PAUSED.
    it('counts 20 concurrent answers exactly once and resumes a still-RUNNING parent when it pauses', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.RUNNING })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 20, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()

        // Each answer decides from status counts; the answers themselves are read once, on completion.
        const findBy = vi.spyOn(Repository.prototype, 'findBy')
        const responses = await Promise.all((join.slotResumeUrls ?? []).map((url, index) => answer({ url, body: { status: index % 5 === 0 ? 'error' : 'success', data: { index } } })))
        const slotReads = findBy.mock.contexts.filter((repository) => repository instanceof Repository && repository.metadata.tableName === 'waitpoint_slot')
        findBy.mockRestore()
        expect(slotReads).toHaveLength(1)

        expect(responses.every((response) => response.json().message.includes('recorded'))).toBe(true)
        const completed = await db.findOneBy<{ status: string, resumePayload: { body: { status: string, data: { results: { status: string, data: { index: number } }[], succeeded: number, failed: number } } } }>('waitpoint', { id: join.id })
        expect(completed?.status).toBe(WaitpointStatus.COMPLETED)
        expect(completed?.resumePayload.body.status).toBe('success')
        expect(completed?.resumePayload.body.data.results.map((result) => result.data.index)).toEqual(Array.from({ length: 20 }, (_, index) => index))
        expect(completed?.resumePayload.body.data).toMatchObject({ succeeded: 16, failed: 4 })

        await createHandlers(app.log).uploadRunLog({ runId: run.id, projectId, status: FlowRunStatus.PAUSED })

        await waitForCondition({ fn: async () => (await db.findOneBy('waitpoint', { id: join.id })) === null })
    })

    it('resumes a PAUSED parent with the aggregate once the last slot is answered', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.PAUSED })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const [first, second] = join.slotResumeUrls ?? []

        await answer({ url: first, body: { status: 'success', data: 1 } })
        expect((await db.findOneBy<{ status: string }>('waitpoint', { id: join.id }))?.status).toBe(WaitpointStatus.PENDING)
        await answer({ url: second, body: { status: 'success', data: 2 } })

        expect(await db.findOneBy('waitpoint', { id: join.id })).toBeNull()
    })

    it('with FAIL_FAST completes at the first failure and drops later answers', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.RUNNING })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 3, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST })).json()
        const [first, second] = join.slotResumeUrls ?? []

        await answer({ url: first, body: { status: 'error', data: { message: 'boom' } } })
        const late = await answer({ url: second, body: { status: 'success', data: 'late' } })
        // A step run again after its join completed dispatches nothing.
        const replay: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 3, failurePolicy: JoinFailurePolicy.enum.FAIL_FAST })).json()
        expect(replay.dispatchedSlots).toEqual([0, 1, 2])

        const completed = await db.findOneBy<{ status: string, resumePayload: { body: { status: string, data: { results: { status: string }[] } } } }>('waitpoint', { id: join.id })
        expect(completed?.status).toBe(WaitpointStatus.COMPLETED)
        expect(completed?.resumePayload.body.status).toBe('error')
        expect(completed?.resumePayload.body.data.results.map((result) => result.status)).toEqual(['error', 'pending', 'pending'])
        expect(late.json().message).toContain('expired')
    })

    it('answers the slot of a child that finished without a Return Response', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.RUNNING })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const slotIds = (join.slotResumeUrls ?? []).map((url) => new URL(url).pathname.split('/').pop() ?? '')
        const failedChild = await saveChild({ projectId, parentRunId: run.id, parentWaitpointId: join.id, parentSlotId: slotIds[0] })
        const silentChild = await saveChild({ projectId, parentRunId: run.id, parentWaitpointId: join.id, parentSlotId: slotIds[1] })

        await createHandlers(app.log).uploadRunLog({ runId: failedChild.id, projectId, status: FlowRunStatus.FAILED, finishTime: new Date().toISOString() })
        await createHandlers(app.log).uploadRunLog({ runId: silentChild.id, projectId, status: FlowRunStatus.SUCCEEDED, finishTime: new Date().toISOString() })

        await waitForCondition({ fn: async () => (await db.findOneBy<{ status: string }>('waitpoint', { id: join.id }))?.status === WaitpointStatus.COMPLETED })
        const completed = await db.findOneBy<{ resumePayload: { body: { data: { results: { status: string, data: unknown }[] } } } }>('waitpoint', { id: join.id })
        const [failed, silent] = completed?.resumePayload.body.data.results ?? []
        expect(failed).toMatchObject({ status: 'error', data: { message: 'Subflow execution failed', status: FlowRunStatus.FAILED } })
        expect(silent).toEqual({ status: 'success', data: null })
        // A join child answers its slot; it never completes the parent's waitpoint on its own.
        const parent = await db.findOneBy<{ status: string }>('flow_run', { id: run.id })
        expect(parent?.status).toBe(FlowRunStatus.RUNNING)
    })

    it('only lets the child a slot was claimed for answer it by finishing', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.RUNNING })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 1, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const slotId = new URL((join.slotResumeUrls ?? [])[0]).pathname.split('/').pop() ?? ''
        await saveChild({ projectId, parentRunId: run.id, parentWaitpointId: join.id, parentSlotId: slotId })

        await joinWaitpointService(app.log).fillSlotForFinishedChild({ childRun: { id: apId(), projectId, status: FlowRunStatus.FAILED, parentRunId: run.id, parentWaitpointId: join.id, parentSlotId: slotId } })

        expect(await db.findOneBy('waitpoint_slot', { id: slotId })).toMatchObject({ status: WaitpointSlotStatus.PENDING })
    })

    it('releases a slot claim when the child run could not be created, so a retry can claim it again', async () => {
        const { run, engineToken, projectId, platformId } = await setupParent({ status: FlowRunStatus.PAUSED })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 1, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const slotId = new URL((join.slotResumeUrls ?? [])[0]).pathname.split('/').pop() ?? ''
        const { flowId, flowVersionId } = await saveFlow({ projectId })
        const startChild = () => flowRunService(app.log).start({
            flowId, flowVersionId, projectId, platformId,
            environment: RunEnvironment.TESTING,
            payload: {},
            executeTrigger: false,
            executionType: ExecutionType.BEGIN,
            workerHandlerId: undefined,
            httpRequestId: undefined,
            streamStepProgress: StreamStepProgress.NONE,
            parentRunId: run.id,
            failParentOnFailure: true,
            parentWaitpointId: join.id,
            parentSlotId: slotId,
        })

        const save = vi.spyOn(Repository.prototype, 'save').mockRejectedValueOnce(new Error('database blip'))
        await expect(startChild()).rejects.toThrow('database blip')
        save.mockRestore()
        expect(await db.findOneBy('waitpoint_slot', { id: slotId })).toMatchObject({ childRunId: null })

        const retried = await startChild()
        expect(await db.findOneBy('flow_run', { id: retried.id })).toMatchObject({ parentSlotId: slotId })
        expect(await db.findOneBy('waitpoint_slot', { id: slotId })).toMatchObject({ childRunId: retried.id })
    })

    it('on timeout resumes with the answers that arrived and marks the rest timed out', async () => {
        const { run, engineToken, projectId } = await setupParent({ status: FlowRunStatus.RUNNING })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 2, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED, timeoutSeconds: 3600 })).json()
        const [first] = join.slotResumeUrls ?? []
        await answer({ url: first, body: { status: 'success', data: 'on time' } })

        await joinWaitpointService(app.log).expire({ flowRunId: run.id, projectId, waitpointId: join.id })

        const completed = await db.findOneBy<{ status: string, resumePayload: { body: { status: string, data: { results: { status: string }[], timedOut: number } } } }>('waitpoint', { id: join.id })
        expect(completed?.status).toBe(WaitpointStatus.COMPLETED)
        expect(completed?.resumePayload.body.data.results.map((result) => result.status)).toEqual(['success', 'timeout'])
        expect(completed?.resumePayload.body.data.timedOut).toBe(1)
    })

    it('attaches a child to a join only with one of its own pending slots as proof', async () => {
        const { run, engineToken, projectId, platformId } = await setupParent({ status: FlowRunStatus.PAUSED })
        const join: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 1, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        const slotId = new URL((join.slotResumeUrls ?? [])[0]).pathname.split('/').pop() ?? ''
        const { flowId, flowVersionId } = await saveFlow({ projectId })
        const startChild = (proof: { parentSlotId?: string }) => flowRunService(app.log).start({
            flowId,
            flowVersionId,
            projectId,
            platformId,
            environment: RunEnvironment.TESTING,
            payload: {},
            executeTrigger: false,
            executionType: ExecutionType.BEGIN,
            workerHandlerId: undefined,
            httpRequestId: undefined,
            streamStepProgress: StreamStepProgress.NONE,
            parentRunId: run.id,
            failParentOnFailure: true,
            parentWaitpointId: join.id,
            ...proof,
        })

        const withoutSlot = await startChild({})
        const withForgedSlot = await startChild({ parentSlotId: apId() })
        const withSlot = await startChild({ parentSlotId: slotId })
        // A second child for the same slot — a replayed dispatch — runs detached from the join.
        const duplicate = await startChild({ parentSlotId: slotId })

        const stored = async (id: string) => db.findOneBy<{ failParentOnFailure: boolean, parentWaitpointId: string | null, parentSlotId: string | null }>('flow_run', { id })
        expect(await stored(withoutSlot.id)).toMatchObject({ failParentOnFailure: false, parentWaitpointId: null, parentSlotId: null })
        expect(await stored(withForgedSlot.id)).toMatchObject({ failParentOnFailure: false, parentWaitpointId: null, parentSlotId: null })
        expect(await stored(withSlot.id)).toMatchObject({ failParentOnFailure: true, parentWaitpointId: join.id, parentSlotId: slotId })
        expect(await stored(duplicate.id)).toMatchObject({ failParentOnFailure: false, parentWaitpointId: null, parentSlotId: null })
        expect(await db.findOneBy('waitpoint_slot', { id: slotId })).toMatchObject({ childRunId: withSlot.id })

        // The parent step run again gets its join back with that slot marked as dispatched.
        const replay: CreateWaitpointResponse = (await createJoin({ engineToken, run, projectId, slots: 1, failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED })).json()
        expect(replay.id).toBe(join.id)
        expect(replay.dispatchedSlots).toEqual([0])
    })
})

async function setupParent(params?: { status?: FlowRunStatus }): Promise<{ run: FlowRun, engineToken: string, projectId: string, platformId: string }> {
    const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
    const { flowId, flowVersionId } = await saveFlow({ projectId: mockProject.id })
    const run = createMockFlowRun({
        projectId: mockProject.id,
        flowId,
        flowVersionId,
        status: params?.status ?? FlowRunStatus.RUNNING,
        environment: RunEnvironment.PRODUCTION,
    })
    await db.save('flow_run', run)
    const engineToken = await generateMockToken({ type: PrincipalType.ENGINE, id: run.id, projectId: mockProject.id, platform: { id: mockPlatform.id } })
    return { run, engineToken, projectId: mockProject.id, platformId: mockPlatform.id }
}

async function saveFlow({ projectId }: { projectId: string }): Promise<{ flowId: string, flowVersionId: string }> {
    const flow = createMockFlow({ projectId })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    return { flowId: flow.id, flowVersionId: flowVersion.id }
}

async function saveChild({ projectId, parentRunId, parentWaitpointId, parentSlotId }: { projectId: string, parentRunId: string, parentWaitpointId: string, parentSlotId: string }): Promise<FlowRun> {
    const { flowId, flowVersionId } = await saveFlow({ projectId })
    const child = createMockFlowRun({ projectId, flowId, flowVersionId, status: FlowRunStatus.RUNNING, environment: RunEnvironment.PRODUCTION, parentRunId })
    await db.save('flow_run', { ...child, parentWaitpointId, parentSlotId, failParentOnFailure: true, dispatchMode: 'QUEUE' })
    // What `queueOrCreateInstantly` does for a verified child: the slot is claimed for it.
    await db.update('waitpoint_slot', parentSlotId, { childRunId: child.id })
    return child
}

function createJoin({ engineToken, run, projectId, slots, failurePolicy, quorum, timeoutSeconds }: CreateJoinParams): Promise<LightMyRequestResponse> {
    return postWaitpoint({
        engineToken,
        payload: {
            flowRunId: run.id,
            projectId,
            stepName: 'fan_out',
            type: 'WEBHOOK',
            version: 'V1',
            internal: true,
            join: { slots, failurePolicy, quorum, timeoutSeconds },
        },
    })
}

function postWaitpoint({ engineToken, payload }: { engineToken: string, payload: Record<string, unknown> }): Promise<LightMyRequestResponse> {
    return app.inject({
        method: 'POST',
        url: '/api/v1/waitpoints',
        headers: { authorization: `Bearer ${engineToken}` },
        payload,
    })
}

function answer({ url, body }: { url: string, body: Record<string, unknown> }): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: `/api${new URL(url).pathname.replace(/^\/api/, '')}`, payload: body })
}

async function waitForCondition({ fn, timeoutMs = 10000 }: { fn: () => Promise<boolean>, timeoutMs?: number }): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('waitForCondition timed out')
}

type CreateJoinParams = {
    engineToken: string
    run: FlowRun
    projectId: string
    slots: number
    failurePolicy: JoinFailurePolicy
    quorum?: number
    timeoutSeconds?: number
}
