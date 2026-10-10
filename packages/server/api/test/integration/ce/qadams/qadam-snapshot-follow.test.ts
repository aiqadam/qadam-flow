import { PinMetadata } from '@aiqadam/server-utils'
import { FlowAction, FlowActionType, FlowStatus, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState, PropertyExecutionType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { PinFallbackSeams } from '../../../../src/app/qadams/pin-moves/qadam-pin-fallback-seams'
import { QadamPinMove } from '../../../../src/app/qadams/pin-moves/qadam-pin-move.dto'
import { qadamPinMoveService } from '../../../../src/app/qadams/pin-moves/qadam-pin-move.service'
import { qadamSnapshotFollow } from '../../../../src/app/qadams/pin-moves/qadam-snapshot-follow'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

const QADAM = '@aiqadam/qadam-snapshot-follow-fixture'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// The pass reads the policy off `process.env`; a test that set it must not leak it into the next one.
beforeEach(() => {
    delete process.env.AP_QADAM_SNAPSHOT_POLICY
})

describe('qadamPinMoveService.followAvailablePins', () => {
    it('moves an available older pin in the caret to the image build on a `-main` instance, with cause SNAPSHOT_FOLLOW', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, instanceIsSnapshot: true, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(result.moved).toHaveLength(1)
        expect(result.stayed).toEqual([])
        expect(pinsOf({ flowVersion: result.flowVersion })).toEqual(['0.4.5'])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
        const records = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
            projectId: ctx.project.id,
            flowId: flow.id,
            flowVersionId: flowVersion.id,
            stepName: 'step_1',
            qadamName: QADAM,
            fromVersion: '0.4.2',
            toVersion: '0.4.5',
            propsCheck: 'not-checked-no-metadata',
            cause: 'SNAPSHOT_FOLLOW',
            status: 'APPLIED',
            movedBy: null,
            revertedAt: null,
            revertedBy: null,
        })
    })

    it('moves a release pin onto a snapshot build inside the caret (ADR-0004)', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5-main.9' }) })

        expect(result.moved).toEqual([expect.objectContaining({ fromVersion: '0.4.2', toVersion: '0.4.5-main.9' })])
    })

    it.each([
        { name: 'a version outside the caret range', imageVersion: '0.5.0', reason: 'outside-caret' },
        { name: 'an image that does not ship the qadam', imageVersion: null, reason: 'image-lacks-qadam' },
    ])('leaves the step alone with $name', async ({ imageVersion, reason }) => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_1', qadamName: QADAM, version: '0.4.2', reason })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('does not move a pin whose metadata is unknown', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'unknown' } }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'props-unverifiable' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
    })

    it('does not move a pin whose props are not compatible', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'found', metadata: { pinned: true } }, check: () => ({ compatible: false, reason: 'prop name was removed' }) }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'props-incompatible', detail: 'prop name was removed' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
    })

    it('does not move a target that did not load, and writes nothing', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', loaded: false }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'target-not-loaded' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('on a release instance leaves a release pin where it is, and writes nothing (ADR-0004)', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await followWith({ ctx, flowVersion, instanceIsSnapshot: false, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_1', qadamName: QADAM, version: '0.4.2', reason: 'release-pin-on-release-instance' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('on a release instance moves a snapshot pin to the image\'s release build inside the caret (ADR-0004)', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2-main.5'] })

        const result = await followWith({ ctx, flowVersion, instanceIsSnapshot: false, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'found', metadata: { pinned: true } } }) })

        expect(result.moved).toEqual([expect.objectContaining({ fromVersion: '0.4.2-main.5', toVersion: '0.4.5', propsCheck: 'compatible' })])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
    })

    it('does not move a pin already at the image build, and writes nothing', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.5'] })

        const result = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'pin-is-image-version' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
    })

    it('respects a REVERTED hold: it does not move the step again', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const first = await followWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await qadamPinMoveService({ log: app.log }).revert({ id: first.moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })
        const reverted = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })

        const second = await followWith({ ctx, flowVersion: reverted, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(second.moved).toEqual([])
        expect(second.stayed).toEqual([expect.objectContaining({ reason: 'reverted-by-user' })])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('does not move a locked version', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        await db.update('flow_version', flowVersion.id, { state: FlowVersionState.LOCKED })
        const locked = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })

        const result = await followWith({ ctx, flowVersion: locked, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(result.moved).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })
})

describe('qadamSnapshotFollow.run', () => {
    it('does nothing when the policy is pin', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        process.env.AP_QADAM_SNAPSHOT_POLICY = 'pin'

        await qadamSnapshotFollow({ log: app.log, seams: fakeSeams({ imageVersion: '0.4.5' }) }).run()

        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('follows a snapshot pin on the draft when the policy is follow', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2-main.5'] })
        process.env.AP_QADAM_SNAPSHOT_POLICY = 'follow'

        await qadamSnapshotFollow({ log: app.log, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'found', metadata: { pinned: true } } }) }).run()

        const records = await db.find<QadamPinMove>('qadam_pin_move', { platformId: ctx.platform.id })
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({ cause: 'SNAPSHOT_FOLLOW', fromVersion: '0.4.2-main.5', toVersion: '0.4.5', movedBy: null })
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
    })

    // The test process runs the release version in the root package.json, so the pass sees a release
    // instance and must not move a release pin even when an operator sets `follow` (ADR-0004).
    it('does not move a release pin on the release test instance, even with policy follow', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        process.env.AP_QADAM_SNAPSHOT_POLICY = 'follow'

        await qadamSnapshotFollow({ log: app.log, seams: fakeSeams({ imageVersion: '0.4.5' }) }).run()

        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })
})

function followWith({ ctx, flowVersion, seams, instanceIsSnapshot = true }: { ctx: TestContext, flowVersion: FlowVersion, seams: FakeSeams, instanceIsSnapshot?: boolean }) {
    return qadamPinMoveService({ log: app.log, seams }).followAvailablePins({ flowVersion, projectId: ctx.project.id, platformId: ctx.platform.id, instanceIsSnapshot })
}

function fakeSeams({ imageVersion, loaded = true, pinMetadata = { status: 'never-published' }, check = () => ({ compatible: true as const }) }: {
    imageVersion: string | null
    loaded?: boolean
    pinMetadata?: PinMetadata
    check?: PinFallbackSeams['propsChecker']['check']
}): FakeSeams {
    return {
        imageBuild: vi.fn(async ({ name }: { name: string }) => {
            if (imageVersion === null || name !== QADAM) {
                return null
            }
            return { build: { version: imageVersion, load: loaded ? { loaded: true as const } : { loaded: false as const, reason: 'import.meta in CJS' } }, metadata: { image: true } }
        }),
        pinMetadata: vi.fn(async (): Promise<PinMetadata> => pinMetadata),
        propsChecker: { check },
    }
}

// A flow version whose trigger is `step_1`'s qadam, with one PIECE action per further pin
// (`step_2`, ...). `pins` are the fixture qadam's versions.
async function seedFlow({ ctx, pins, status = FlowStatus.DISABLED }: { ctx: TestContext, pins: string[], status?: FlowStatus }): Promise<{ flow: { id: string }, flowVersion: FlowVersion }> {
    const flow = createMockFlow({ projectId: ctx.project.id, status })
    await db.save('flow', flow)
    const [first, ...rest] = pins
    const actions = rest.map((pin, index) => pieceAction({ name: `step_${index + 2}`, qadamName: QADAM, qadamVersion: pin }))
    const trigger: FlowTrigger = {
        type: FlowTriggerType.PIECE,
        name: 'step_1',
        displayName: 'Trigger',
        valid: true,
        lastUpdatedDate: new Date().toISOString(),
        settings: {
            qadamName: QADAM,
            qadamVersion: first,
            triggerName: 'do_it',
            input: {},
            propertySettings: {},
        },
        nextAction: chain({ actions }),
    }
    const flowVersion = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger })
    await db.save('flow_version', flowVersion)
    return { flow, flowVersion }
}

function chain({ actions }: { actions: FlowAction[] }): FlowAction | undefined {
    return actions.reduceRight<FlowAction | undefined>((next, action) => ({ ...action, nextAction: next }), undefined)
}

function pieceAction({ name, qadamName, qadamVersion }: { name: string, qadamName: string, qadamVersion: string }): FlowAction {
    return {
        type: FlowActionType.PIECE,
        name,
        displayName: name,
        valid: true,
        lastUpdatedDate: new Date().toISOString(),
        settings: {
            qadamName,
            qadamVersion,
            actionName: 'do_it',
            input: {},
            propertySettings: { value: { type: PropertyExecutionType.MANUAL } },
            errorHandlingOptions: {},
        },
    }
}

function pinsOf({ flowVersion }: { flowVersion: FlowVersion }): string[] {
    const steps: { settings: { qadamName?: string, qadamVersion?: string } }[] = []
    let step: { settings: { qadamName?: string, qadamVersion?: string }, nextAction?: unknown } | undefined = flowVersion.trigger
    while (step !== undefined) {
        steps.push(step)
        step = isStep(step.nextAction) ? step.nextAction : undefined
    }
    return steps.filter((candidate) => candidate.settings.qadamName === QADAM).map((candidate) => candidate.settings.qadamVersion ?? '')
}

function isStep(value: unknown): value is { settings: { qadamName?: string, qadamVersion?: string }, nextAction?: unknown } {
    return typeof value === 'object' && value !== null && 'settings' in value
}

type FakeSeams = {
    imageBuild: ReturnType<typeof vi.fn<PinFallbackSeams['imageBuild']>>
    pinMetadata: PinFallbackSeams['pinMetadata']
    propsChecker: PinFallbackSeams['propsChecker']
}
