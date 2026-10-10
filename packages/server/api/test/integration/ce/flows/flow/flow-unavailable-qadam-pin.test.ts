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
import { qadamCache } from '../../../../../src/app/qadams/metadata/qadam-cache'
import { QadamPinMove } from '../../../../../src/app/qadams/pin-moves/qadam-pin-move.dto'
import { db } from '../../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata } from '../../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'

const QADAM = '@aiqadam/qadam-schedule'
const STALE_PIN = '0.1.4'
const IMAGE_VERSION = '0.1.5'

// The service's own seams, so the image is the one this test names and nothing depends on which
// qadams the test run built. Everything else is the real service, the real database and the real
// publish and enable paths.
const seams = vi.hoisted(() => ({
    imageBuild: vi.fn(),
    pinMetadata: vi.fn(async () => null),
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

describe('publishing and enabling a flow with a qadam pin that is not available (#808)', () => {
    it('moves the pin before the draft is locked, so the published version runs the image build', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: {} })

        expect(response.statusCode).toBe(StatusCodes.OK)
        const published = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })
        expect(published.state).toBe(FlowVersionState.LOCKED)
        expect(pinOf({ flowVersion: published })).toBe(IMAGE_VERSION)
        const records = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })
        expect(records).toEqual([expect.objectContaining({ flowVersionId: flowVersion.id, fromVersion: STALE_PIN, toVersion: IMAGE_VERSION, cause: 'PUBLISH', movedBy: ctx.user.id, status: 'APPLIED' })])
        expect((await db.findOneByOrFail<Flow>('flow', { id: flow.id })).status).toBe(FlowStatus.ENABLED)
    })

    it('moves the pin of an already published version when the flow is enabled, attributed to the status change', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.CHANGE_STATUS, request: { status: FlowStatus.ENABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(IMAGE_VERSION)
        const records = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })
        expect(records).toEqual([expect.objectContaining({ cause: 'ENABLE', movedBy: null, fromVersion: STALE_PIN, toVersion: IMAGE_VERSION })])
    })

    it('does not move a pin when disabling a flow', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.LOCKED, status: FlowStatus.ENABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.CHANGE_STATUS, request: { status: FlowStatus.DISABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(STALE_PIN)
        expect(seams.imageBuild).not.toHaveBeenCalled()
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
    })

    it('still publishes, with the pin as it was, when checking the pin fails', async () => {
        const ctx = await createTestContext(app)
        seams.imageBuild.mockRejectedValue(new Error('the image manifest could not be read'))
        const { flow, flowVersion } = await seedFlow({ ctx, state: FlowVersionState.DRAFT, status: FlowStatus.DISABLED })

        const response = await ctx.post(`/v1/flows/${flow.id}`, { type: FlowOperationType.LOCK_AND_PUBLISH, request: { status: FlowStatus.DISABLED } })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(pinOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toBe(STALE_PIN)
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
    })
})

async function seedFlow({ ctx, state, status }: { ctx: TestContext, state: FlowVersionState, status: FlowStatus }): Promise<{ flow: Flow, flowVersion: FlowVersion }> {
    const flow = createMockFlow({ projectId: ctx.project.id, status })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state, valid: true, trigger: scheduleTrigger() })
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

function scheduleTrigger(): FlowTrigger {
    return {
        type: FlowTriggerType.PIECE,
        settings: {
            qadamName: QADAM,
            qadamVersion: STALE_PIN,
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
