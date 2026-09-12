import {
    apId,
    FlowRunStatus,
    FlowStatus,
    FlowTriggerType,
    INLINE_SUBFLOW_DEPTH_LIMIT,
    RunEnvironment,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { inlineFlowRunService } from '../../../../../src/app/workers/rpc/inline-flow-run.service'
import { db } from '../../../../helpers/db'
import {
    createMockFlow,
    createMockFlowVersion,
    createMockProject,
    mockAndSaveBasicSetup,
} from '../../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function createCallableFlow(projectId: string) {
    const flow = createMockFlow({ projectId, status: FlowStatus.ENABLED })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({
        flowId: flow.id,
        trigger: {
            type: FlowTriggerType.PIECE,
            name: 'trigger',
            displayName: 'Callable Flow',
            valid: true,
            lastUpdatedDate: new Date().toISOString(),
            settings: {
                qadamName: '@aiqadam/qadam-subflows',
                qadamVersion: '0.4.14',
                triggerName: 'callableFlow',
                input: {},
                propertySettings: {},
            },
        },
    })
    await db.save('flow_version', flowVersion)
    await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })
    return flow
}

async function seedRunChain(length: number, projectId: string): Promise<string> {
    // flow_run.flowId/flowVersionId are FK-constrained — the ancestry chain used for the
    // depth guard doesn't care which flow each hop belongs to, so a single throwaway
    // flow/version is reused for every synthetic row.
    const anchorFlow = createMockFlow({ projectId, status: FlowStatus.ENABLED })
    await db.save('flow', anchorFlow)
    const anchorFlowVersion = createMockFlowVersion({ flowId: anchorFlow.id })
    await db.save('flow_version', anchorFlowVersion)

    let parentRunId: string | undefined
    let lastId = ''
    for (let i = 0; i < length; i++) {
        const id = apId()
        await db.save('flow_run', {
            id,
            projectId,
            flowId: anchorFlow.id,
            flowVersionId: anchorFlowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            parentRunId,
            failParentOnFailure: true,
            status: FlowRunStatus.SUCCEEDED,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            tags: [],
        })
        parentRunId = id
        lastId = id
    }
    return lastId
}

describe('inlineFlowRunService', () => {
    it('rejects a flow that belongs to a different project', async () => {
        const { mockPlatform: platformA, mockProject: projectA } = await mockAndSaveBasicSetup()
        const { mockOwner: ownerB } = await mockAndSaveBasicSetup()
        const projectB = createMockProject({ platformId: platformA.id, ownerId: ownerB.id })
        await db.save('project', projectB)

        const flowInProjectB = await createCallableFlow(projectB.id)
        const parentRun = await seedRunChain(1, projectA.id)

        // The project-scoped lookup (flowService.getOneOrThrow({ id, projectId })) can't
        // distinguish "wrong project" from "doesn't exist" — same as every other
        // project-scoped 404 in this codebase, it throws rather than returning null.
        await expect(inlineFlowRunService(app!.log).start({
            callerProjectId: projectA.id,
            callerPlatformId: platformA.id,
            parentRunId: parentRun,
            environment: RunEnvironment.PRODUCTION,
            flowId: flowInProjectB.id,
            payload: {},
        })).rejects.toThrow()
    })

    it('rejects a disabled flow', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const flow = await createCallableFlow(mockProject.id)
        await db.update('flow', flow.id, { status: FlowStatus.DISABLED })
        const parentRun = await seedRunChain(1, mockProject.id)

        const result = await inlineFlowRunService(app!.log).start({
            callerProjectId: mockProject.id,
            callerPlatformId: mockPlatform.id,
            parentRunId: parentRun,
            environment: RunEnvironment.PRODUCTION,
            flowId: flow.id,
            payload: {},
        })

        expect(result).toEqual(expect.objectContaining({ ok: false }))
    })

    it('rejects a flow whose trigger is not "Callable Flow"', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const flow = createMockFlow({ projectId: mockProject.id, status: FlowStatus.ENABLED })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({
            flowId: flow.id,
            trigger: {
                type: FlowTriggerType.PIECE,
                name: 'trigger',
                displayName: 'Catch Webhook',
                valid: true,
                lastUpdatedDate: new Date().toISOString(),
                settings: {
                    qadamName: '@aiqadam/qadam-webhook',
                    qadamVersion: '0.1.34',
                    triggerName: 'catch_webhook',
                    input: {},
                    propertySettings: {},
                },
            },
        })
        await db.save('flow_version', flowVersion)
        await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })
        const parentRun = await seedRunChain(1, mockProject.id)

        const result = await inlineFlowRunService(app!.log).start({
            callerProjectId: mockProject.id,
            callerPlatformId: mockPlatform.id,
            parentRunId: parentRun,
            environment: RunEnvironment.PRODUCTION,
            flowId: flow.id,
            payload: {},
        })

        expect(result.ok).toBe(false)
    })

    it('rejects once the parent run chain is already at the depth limit', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const flow = await createCallableFlow(mockProject.id)
        // A chain of exactly the limit means the NEXT child would be depth limit+1.
        const deepestRunId = await seedRunChain(INLINE_SUBFLOW_DEPTH_LIMIT, mockProject.id)

        const result = await inlineFlowRunService(app!.log).start({
            callerProjectId: mockProject.id,
            callerPlatformId: mockPlatform.id,
            parentRunId: deepestRunId,
            environment: RunEnvironment.PRODUCTION,
            flowId: flow.id,
            payload: {},
        })

        expect(result).toEqual(expect.objectContaining({ ok: false }))
    })

    it('creates a scoped child FlowRun row when everything checks out', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        const flow = await createCallableFlow(mockProject.id)
        const parentRun = await seedRunChain(1, mockProject.id)

        const result = await inlineFlowRunService(app!.log).start({
            callerProjectId: mockProject.id,
            callerPlatformId: mockPlatform.id,
            parentRunId: parentRun,
            environment: RunEnvironment.PRODUCTION,
            flowId: flow.id,
            payload: { hello: 'world' },
        })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.inlineDepth).toBe(2)

        const childRun = await db.findOneBy<{ parentRunId: string, projectId: string }>('flow_run', {
            id: result.childRunId,
        })
        expect(childRun?.parentRunId).toBe(parentRun)
        expect(childRun?.projectId).toBe(mockProject.id)
    })
})
