import { WebhookRenewStrategy } from '@aiqadam/qadams-framework'
import {
    Flow,
    FlowOperationType,
    FlowStatus,
    FlowTrigger,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    PackageType,
    PropertyExecutionType,
    QadamType,
    TriggerStrategy,
    TriggerTestStrategy,
    WebhookHandshakeStrategy,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import * as flowExecutionCacheModule from '../../../../../src/app/flows/flow/flow-execution-cache'
import { qadamCache } from '../../../../../src/app/qadams/metadata/qadam-cache'
import { QadamPinMove } from '../../../../../src/app/qadams/pin-moves/qadam-pin-move.dto'
import * as triggerSourceModule from '../../../../../src/app/trigger/trigger-source/trigger-source-service'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

const QADAM = '@aiqadam/qadam-schedule'
const STALE_PIN = '0.1.4'
const IMAGE_VERSION = '0.1.5'

// The service's own seams, so the image is the one this test names and nothing depends on which
// qadams the test run built. Everything else is the real service, the real database and the real
// publish path.
const seams = vi.hoisted(() => ({
    imageBuild: vi.fn(),
    pinMetadata: vi.fn(async (): Promise<{ status: 'never-published' }> => ({ status: 'never-published' })),
    propsChecker: { check: () => ({ compatible: true as const }) },
}))

vi.mock('../../../../../src/app/qadams/pin-moves/qadam-pin-fallback-seams', () => ({
    qadamPinFallbackSeams: () => seams,
}))

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    seams.imageBuild.mockReset()
    seams.imageBuild.mockResolvedValue({ build: { version: IMAGE_VERSION, load: { loaded: true } }, metadata: { image: true } })
    await db.delete('qadam_metadata', { name: QADAM })
    await db.save('qadam_metadata', imageQadamMetadata())
    await qadamCache(app.log).invalidate()
})

describe('a failed publish of an enabled flow (#808)', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('registers the previous published version\'s trigger source again, not the draft\'s', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion: previous } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.ENABLED, pin: IMAGE_VERSION })
        const draft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: scheduleTrigger(), created: new Date().toISOString() })
        await db.save('flow_version', draft)
        vi.spyOn(flowExecutionCacheModule, 'flowExecutionCache').mockImplementation(() => ({ get: vi.fn(), invalidate: vi.fn().mockRejectedValue(new Error('redis is down')) }))

        const publish = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: {} })

        expect(publish.statusCode).not.toBe(StatusCodes.OK)
        const stored = await db.findOneByOrFail<Flow>('flow', { id: flow.id })
        expect(stored).toMatchObject({ status: FlowStatus.ENABLED, publishedVersionId: previous.id })
        expect((await db.findOneByOrFail<FlowVersion>('flow_version', { id: draft.id })).state).toBe(FlowVersionState.DRAFT)
        const sources = await db.find<{ flowVersionId: string }>('trigger_source', { flowId: flow.id, simulate: false })
        expect(sources.map((source) => source.flowVersionId)).toEqual([previous.id])
    })

    it('does not register it again for a flow a person disabled meanwhile', async () => {
        const ctx = await createTestContext(app)
        const { flow } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.ENABLED, pin: IMAGE_VERSION })
        const draft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: scheduleTrigger(), created: new Date().toISOString() })
        await db.save('flow_version', draft)
        vi.spyOn(flowExecutionCacheModule, 'flowExecutionCache').mockImplementation(() => ({ get: vi.fn(), invalidate: vi.fn().mockRejectedValue(new Error('redis is down')) }))
        const realTriggerSources = triggerSourceModule.triggerSourceService
        // A person disables the flow while the publish is under way, after its trigger source was disabled.
        vi.spyOn(triggerSourceModule, 'triggerSourceService').mockImplementation((log) => {
            const real = realTriggerSources(log)
            return { ...real, disable: async (params) => {
                await real.disable(params)
                await db.update('flow', flow.id, { status: FlowStatus.DISABLED })
            } }
        })

        await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: {} })

        expect(await db.find('trigger_source', { flowId: flow.id, simulate: false })).toEqual([])
    })

    it('registers nothing when the flow was not enabled, so no trigger source was disabled', async () => {
        const ctx = await createTestContext(app)
        const { flow } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.DISABLED, pin: IMAGE_VERSION })
        const draft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: scheduleTrigger(), created: new Date().toISOString() })
        await db.save('flow_version', draft)
        vi.spyOn(flowExecutionCacheModule, 'flowExecutionCache').mockImplementation(() => ({ get: vi.fn(), invalidate: vi.fn().mockRejectedValue(new Error('redis is down')) }))

        await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(await db.find('trigger_source', { flowId: flow.id, simulate: false })).toEqual([])
    })
})

describe('publishing a flow with a qadam pin that is not available (#808)', () => {
    it('moves the pin in the draft before it is locked, so the published version runs the image build', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const published = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })
        expect(published.state).toBe(FlowVersionState.LOCKED)
        expect(pinOf({ flowVersion: published })).toBe(IMAGE_VERSION)
        const records = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })
        expect(records).toEqual([expect.objectContaining({ flowVersionId: flowVersion.id, fromVersion: STALE_PIN, toVersion: IMAGE_VERSION, cause: 'PUBLISH', movedBy: ctx.user.id, status: 'APPLIED' })])
        expect((await db.findOneByOrFail<Flow>('flow', { id: flow.id })).publishedVersionId).toBe(flowVersion.id)
    })

    it('still publishes, with the pin as it was, when the image cannot take the step', async () => {
        const ctx = await createTestContext(app)
        seams.imageBuild.mockResolvedValue({ build: { version: '0.2.0', load: { loaded: true } }, metadata: { image: true } })
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const published = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })
        expect(published.state).toBe(FlowVersionState.LOCKED)
        expect(pinOf({ flowVersion: published })).toBe(STALE_PIN)
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(seams.imageBuild).toHaveBeenCalledTimes(1)
    })

    it('still publishes, with the pin as it was, when checking the pin fails', async () => {
        const ctx = await createTestContext(app)
        seams.imageBuild.mockRejectedValue(new Error('the image manifest could not be read'))
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(STALE_PIN)
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(seams.imageBuild).toHaveBeenCalledTimes(1)
    })

    it('attributes the move to the publisher and checks the pins once', async () => {
        const ctx = await createTestContext(app)
        const { flow } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(seams.imageBuild).toHaveBeenCalledTimes(1)
        expect(await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([expect.objectContaining({ cause: 'PUBLISH', movedBy: ctx.user.id })])
    })

    it('keeps a reverted pin: publish, revert (no draft yet), publish again', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })
        await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })
        const [record] = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })

        const revert = await ctx.post(`/v1/qadam-pin-moves/${record.id}/revert`)

        expect(revert.statusCode).toBe(StatusCodes.OK)
        expect(revert.json<{ publishRequired: boolean }>().publishRequired).toBe(true)
        // The published version is untouched and keeps running; a draft carries the old pin.
        const afterRevert = await db.findOneByOrFail<Flow>('flow', { id: flow.id })
        expect(afterRevert.publishedVersionId).toBe(flowVersion.id)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(IMAGE_VERSION)
        const drafts = await db.find<FlowVersion>('flow_version', { flowId: flow.id, state: FlowVersionState.DRAFT })
        expect(drafts.map((draft) => pinOf({ flowVersion: draft }))).toEqual([STALE_PIN])

        const publish = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(publish.statusCode).toBe(StatusCodes.OK)
        const live = await db.findOneByOrFail<Flow>('flow', { id: flow.id })
        expect(live.publishedVersionId).toBe(drafts[0].id)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: drafts[0].id }) })).toBe(STALE_PIN)
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([expect.objectContaining({ id: record.id, status: 'REVERTED' })])
    })

    it('does not move the pins of a flow whose latest version is already locked', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.DISABLED })

        const publish = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(publish.statusCode).toBe(StatusCodes.OK)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(STALE_PIN)
        expect(seams.imageBuild).not.toHaveBeenCalled()
    })
})

async function seedFlow({ ctx, state, status, pin = STALE_PIN }: { ctx: TestContext, state: FlowVersionState, status: FlowStatus, pin?: string }): Promise<{ flow: Flow, flowVersion: FlowVersion }> {
    const flow = createMockFlow({ projectId: ctx.project.id, status })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state, valid: true, trigger: scheduleTrigger({ pin }) })
    await db.save('flow_version', flowVersion)
    if (state === FlowVersionState.LOCKED) {
        await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })
    }
    return { flow, flowVersion }
}

function imageQadamMetadata() {
    return createMockQadamMetadata({
        name: QADAM,
        version: IMAGE_VERSION,
        triggers: {
            every_hour: {
                name: 'every_hour',
                displayName: 'Every Hour',
                description: 'Triggers the current flow every hour',
                requireAuth: true,
                props: {},
                type: TriggerStrategy.WEBHOOK,
                handshakeConfiguration: { strategy: WebhookHandshakeStrategy.NONE },
                renewConfiguration: { strategy: WebhookRenewStrategy.NONE },
                sampleData: {},
                testStrategy: TriggerTestStrategy.TEST_FUNCTION,
            },
        },
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    })
}

function scheduleTrigger({ pin = STALE_PIN }: { pin?: string } = {}): FlowTrigger {
    return {
        type: FlowTriggerType.PIECE,
        settings: {
            qadamName: QADAM,
            qadamVersion: pin,
            input: { run_on_weekends: false },
            triggerName: 'every_hour',
            propertySettings: {
                run_on_weekends: { type: PropertyExecutionType.MANUAL },
            },
        },
        valid: true,
        name: 'trigger',
        displayName: 'Schedule',
        lastUpdatedDate: new Date().toISOString(),
    }
}

function pinOf({ flowVersion }: { flowVersion: FlowVersion }): string | undefined {
    const { trigger } = flowVersion
    return trigger.type === FlowTriggerType.PIECE ? trigger.settings.qadamVersion : undefined
}
