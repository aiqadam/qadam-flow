import { apId, CreateWaitpointResponse, FlowRun, FlowRunDispatchMode, FlowRunStatus, FlowVersionState, PrincipalType, RunEnvironment } from '@aiqadam/shared'
import { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { systemJobsQueue } from '../../../../../src/app/helper/system-jobs/system-job'
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

async function createFlowRunInProject(params: { projectId: string, status?: FlowRunStatus, parentRunId?: string, dispatchMode?: FlowRunDispatchMode }): Promise<FlowRun> {
    const { projectId, status, parentRunId, dispatchMode } = params
    const flow = createMockFlow({ projectId })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
    await db.save('flow_version', flowVersion)
    const flowRun = createMockFlowRun({
        projectId,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: status ?? FlowRunStatus.RUNNING,
        environment: RunEnvironment.PRODUCTION,
        parentRunId,
    })
    // createMockFlowRun doesn't carry dispatchMode (the field postdates it), so it's added
    // directly onto the row being saved rather than by extending the shared mock helper.
    await db.save('flow_run', { ...flowRun, dispatchMode })
    return flowRun
}

async function generateEngineToken(params: { projectId: string, platformId: string, id?: string }): Promise<string> {
    return generateMockToken({
        type: PrincipalType.ENGINE,
        id: params.id ?? apId(),
        projectId: params.projectId,
        platform: { id: params.platformId },
    })
}

function postWaitpoint(params: { engineToken: string, payload: Record<string, unknown> }): Promise<LightMyRequestResponse> {
    const { engineToken, payload } = params
    return app.inject({
        method: 'POST',
        url: '/api/v1/waitpoints',
        headers: { authorization: `Bearer ${engineToken}` },
        payload,
    })
}

describe('Waitpoint controller — engine project isolation (#516)', () => {
    it('rejects a create when the body projectId does not match the engine token\'s own project', async () => {
        const { mockProject: projectA, mockPlatform: platformA } = await mockAndSaveBasicSetup()
        const { mockProject: projectB } = await mockAndSaveBasicSetup()
        const runB = await createFlowRunInProject({ projectId: projectB.id })
        const engineToken = await generateEngineToken({ projectId: projectA.id, platformId: platformA.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: runB.id,
                projectId: projectB.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(403)
        const stored = await db.findOneBy('waitpoint', { flowRunId: runB.id })
        expect(stored).toBeNull()
    })

    it('rejects creating a waitpoint on another project\'s run even when the body claims the caller\'s own projectId', async () => {
        const { mockProject: projectA, mockPlatform: platformA } = await mockAndSaveBasicSetup()
        const { mockProject: projectB } = await mockAndSaveBasicSetup()
        const runB = await createFlowRunInProject({ projectId: projectB.id })
        const engineToken = await generateEngineToken({ projectId: projectA.id, platformId: platformA.id })
        const resumeDateTime = new Date(Date.now() + 60_000).toISOString()

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: runB.id,
                projectId: projectA.id,
                stepName: 'delay_step',
                type: 'DELAY',
                version: 'V1',
                resumeDateTime,
            },
        })

        expect(response.statusCode).toBe(403)
        const stored = await db.findOneBy('waitpoint', { flowRunId: runB.id })
        expect(stored).toBeNull()

        const scheduledJob = await systemJobsQueue.getJob(`resume-delay-${runB.id}`)
        expect(scheduledJob).toBeUndefined()
    })

    it('rejects a same-project run that is not the caller\'s own run and not its descendant', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const unrelatedRun = await createFlowRunInProject({ projectId: mockProject.id })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: unrelatedRun.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(403)
        const stored = await db.findOneBy('waitpoint', { flowRunId: unrelatedRun.id })
        expect(stored).toBeNull()
    })

    it('does not leak another project\'s pre-completed waitpoint (id/resumeUrl) through the create endpoint', async () => {
        const { mockProject: projectA, mockPlatform: platformA } = await mockAndSaveBasicSetup()
        const { mockProject: projectB } = await mockAndSaveBasicSetup()
        const runB = await createFlowRunInProject({ projectId: projectB.id })
        const secretWaitpointId = apId()
        await db.save('waitpoint', {
            id: secretWaitpointId,
            flowRunId: runB.id,
            projectId: projectB.id,
            stepName: 'approval',
            type: 'WEBHOOK',
            version: 'V1',
            status: 'COMPLETED',
            httpRequestId: null,
            workerHandlerId: null,
            resumePayload: { body: { secret: 'project-b-only' } },
        })
        const engineToken = await generateEngineToken({ projectId: projectA.id, platformId: platformA.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: runB.id,
                projectId: projectA.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(403)
        expect(response.body).not.toContain(secretWaitpointId)
    })

    it('lets the engine pause its own run (WEBHOOK)', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const run = await createFlowRunInProject({ projectId: mockProject.id })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: run.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: run.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(201)
        const body = response.json<CreateWaitpointResponse>()
        expect(body.id).toBeDefined()
        const stored = await db.findOneByOrFail<{ id: string, flowRunId: string, projectId: string }>('waitpoint', { flowRunId: run.id })
        expect(stored.projectId).toBe(mockProject.id)
        expect(stored.id).toBe(body.id)
    })

    it('lets the engine schedule a DELAY pause for its own run', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const run = await createFlowRunInProject({ projectId: mockProject.id })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: run.id })
        const resumeDateTime = new Date(Date.now() + 60_000).toISOString()

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: run.id,
                projectId: mockProject.id,
                stepName: 'delay_step',
                type: 'DELAY',
                version: 'V1',
                resumeDateTime,
            },
        })

        expect(response.statusCode).toBe(201)
        const scheduledJob = await systemJobsQueue.getJob(`resume-delay-${run.id}`)
        expect(scheduledJob?.id).toBe(`resume-delay-${run.id}`)
    })

    it('lets a top-level run pause even when its own flow_run row has not been flushed yet (#509 ordering trap)', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        // No flow_run row is ever created for this id — the fast path in assertCallerOwnsRun
        // (flowRunId === callerRunId) needs no database round trip, so a PRODUCTION run whose
        // row is still owed by the runs-metadata queue must still be able to pause.
        const unflushedRunId = apId()
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: unflushedRunId })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: unflushedRunId,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(201)
        const stored = await db.findOneBy('waitpoint', { flowRunId: unflushedRunId })
        expect(stored).not.toBeNull()
    })

    it('accepts an inline callFlow child\'s waitpoint HTTP call even though the parent job\'s own row has not been flushed yet (#509 ordering trap, inline path)', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        // The parent (top-level) run's own row is deliberately never persisted — the ancestry
        // check must not need it: the child's own row already carries parentRunId, which is all
        // isRunDescendantOfCallerJob matches against.
        const unflushedParentRunId = apId()
        const childRun = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: unflushedParentRunId, dispatchMode: 'INLINE' })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: unflushedParentRunId })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: childRun.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        // This does NOT mean the inline child actually pauses end-to-end: inline-flow-executor.ts
        // throws a user-facing error the moment the child's own executor returns a PAUSED verdict
        // ("cannot be called with Execution Mode Inline because it pauses"), because an inline
        // child runs synchronously in the parent's process with no mechanism to actually suspend
        // it. That HTTP call happens first, though, so this endpoint accepting it is what lets the
        // accurate "not supported inline" error surface afterwards instead of a confusing 403 from
        // here.
        expect(response.statusCode).toBe(201)
        const stored = await db.findOneBy('waitpoint', { flowRunId: childRun.id })
        expect(stored).not.toBeNull()
    })

    it('rejects a QUEUE-mode child of the caller\'s own run — it has its own job and its own engine token', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const parentRun = await createFlowRunInProject({ projectId: mockProject.id })
        const queueModeChild = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: parentRun.id, dispatchMode: 'QUEUE' })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: parentRun.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: queueModeChild.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(403)
        const stored = await db.findOneBy('waitpoint', { flowRunId: queueModeChild.id })
        expect(stored).toBeNull()
    })

    it('accepts a two-level inline chain (grandchild INLINE -> child INLINE -> caller run)', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const callerRun = await createFlowRunInProject({ projectId: mockProject.id })
        const child = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: callerRun.id, dispatchMode: 'INLINE' })
        const grandchild = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: child.id, dispatchMode: 'INLINE' })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: callerRun.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: grandchild.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(201)
        const stored = await db.findOneBy('waitpoint', { flowRunId: grandchild.id })
        expect(stored).not.toBeNull()
    })

    it('rejects a two-level inline chain when the middle hop is QUEUE-mode (grandchild INLINE -> child QUEUE -> caller run)', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const callerRun = await createFlowRunInProject({ projectId: mockProject.id })
        const child = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: callerRun.id, dispatchMode: 'QUEUE' })
        const grandchild = await createFlowRunInProject({ projectId: mockProject.id, parentRunId: child.id, dispatchMode: 'INLINE' })
        const engineToken = await generateEngineToken({ projectId: mockProject.id, platformId: mockPlatform.id, id: callerRun.id })

        const response = await postWaitpoint({
            engineToken,
            payload: {
                flowRunId: grandchild.id,
                projectId: mockProject.id,
                stepName: 'approval',
                type: 'WEBHOOK',
                version: 'V1',
            },
        })

        expect(response.statusCode).toBe(403)
        const stored = await db.findOneBy('waitpoint', { flowRunId: grandchild.id })
        expect(stored).toBeNull()
    })
})
