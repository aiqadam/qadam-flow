import { PinMetadata } from '@aiqadam/server-utils'
import { apId, FlowAction, FlowActionType, FlowStatus, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState, PackageType, PlatformRole, PrincipalType, PropertyExecutionType, QadamType, SeekPage } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { qadamCache } from '../../../../src/app/qadams/metadata/qadam-cache'
import { PinFallbackSeams } from '../../../../src/app/qadams/pin-moves/qadam-pin-fallback-seams'
import { QadamPinMove } from '../../../../src/app/qadams/pin-moves/qadam-pin-move.dto'
import { qadamPinMoveService } from '../../../../src/app/qadams/pin-moves/qadam-pin-move.service'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata, mockBasicUser } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

const QADAM = '@aiqadam/qadam-pin-move-fixture'
const OTHER_QADAM = '@aiqadam/qadam-pin-move-other-fixture'

let app: FastifyInstance

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// The registry the pin check reads is cached per process; a test that saves a version drops it.
beforeEach(async () => {
    await db.delete('qadam_metadata', { name: QADAM })
    await qadamCache(app.log).invalidate()
})

describe('qadamPinMoveService.moveUnavailablePins', () => {
    it('moves a pin that was never published to the image build and writes one audit record with it', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }), actorUserId: ctx.user.id })

        expect(result.moved).toHaveLength(1)
        expect(result.stayed).toEqual([])
        expect(pinsOf({ flowVersion: result.flowVersion })).toEqual(['0.4.5'])
        const stored = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })
        expect(pinsOf({ flowVersion: stored })).toEqual(['0.4.5'])
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
            cause: 'PUBLISH',
            status: 'APPLIED',
            movedBy: ctx.user.id,
            revertedAt: null,
            revertedBy: null,
        })
    })

    it('never disables the flow', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'], status: FlowStatus.ENABLED })

        await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: null }) })

        expect((await db.findOneByOrFail<{ status: FlowStatus }>('flow', { id: flow.id })).status).toBe(FlowStatus.ENABLED)
    })

    it('rewrites the step pin and nothing else about the step', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        const before = JSON.parse(JSON.stringify(flowVersion.trigger))
        const after = JSON.parse(JSON.stringify(result.flowVersion.trigger))
        before.settings.qadamVersion = '0.4.5'
        expect(after).toEqual(before)
    })

    it.each([
        { name: 'a version outside the caret range', imageVersion: '0.5.0', reason: 'outside-caret' },
        { name: 'an image that does not ship the qadam', imageVersion: null, reason: 'image-lacks-qadam' },
    ])('leaves the step alone with $name', async ({ imageVersion, reason }) => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_1', qadamName: QADAM, version: '0.4.2', reason })])
        expect(result.flowVersion).toBe(flowVersion)
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('does not move a step to a target that did not load, and does not write', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', loaded: false }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'target-not-loaded' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('checks the props where the pinned version has metadata, against the step\'s own trigger', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const check = vi.fn(() => ({ compatible: true as const }))

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'found', metadata: { pinned: true } }, check }) })

        expect(check).toHaveBeenCalledWith({ from: { pinned: true }, to: { image: true }, target: { kind: 'trigger', name: 'do_it' } })
        expect(result.moved).toEqual([expect.objectContaining({ propsCheck: 'compatible' })])
    })

    it('does not move a step whose props are not compatible', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'found', metadata: { pinned: true } }, check: () => ({ compatible: false, reason: 'prop name was removed' }) }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'props-incompatible', detail: 'prop name was removed' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
    })

    it('does not read the pinned version\'s metadata when the image ships no build', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const seams = fakeSeams({ imageVersion: null })

        await moveWith({ ctx, flowVersion, seams })

        expect(seams.pinMetadata).not.toHaveBeenCalled()
    })

    it('does not move a pin when the instance cannot tell whether it was ever published', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5', pinMetadata: { status: 'unknown' } }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'props-unverifiable' })])
        expect(await db.find('qadam_pin_move', { platformId: ctx.platform.id })).toEqual([])
    })

    it('drops a planned move whose step a person reverted while it was being planned', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const seams = fakeSeams({ imageVersion: '0.4.5' })
        seams.imageBuild.mockImplementation(async () => {
            const now = new Date().toISOString()
            await db.save('qadam_pin_move', {
                id: apId(), created: now, updated: now, platformId: ctx.platform.id, projectId: ctx.project.id, flowId: flow.id, flowVersionId: flowVersion.id,
                stepName: 'step_1', qadamName: QADAM, fromVersion: '0.4.2', toVersion: '0.4.5', propsCheck: 'not-checked-no-metadata', cause: 'PUBLISH', status: 'REVERTED',
                movedBy: null, revertedAt: now, revertedBy: ctx.user.id,
            })
            return { build: { version: '0.4.5', load: { loaded: true } }, metadata: { image: true } }
        })

        const result = await moveWith({ ctx, flowVersion, seams })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_1', reason: 'reverted-by-user' })])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('does not touch a pin the instance holds, and does not even look at the image for it', async () => {
        const ctx = await createTestContext(app)
        await saveQadamVersion({ version: '0.4.2' })
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const seams = fakeSeams({ imageVersion: '0.4.5' })

        const result = await moveWith({ ctx, flowVersion, seams })

        expect(result).toEqual({ flowVersion, moved: [], stayed: [] })
        expect(seams.imageBuild).not.toHaveBeenCalled()
    })

    it('leaves a range pin alone', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['^0.4.2'] })
        const seams = fakeSeams({ imageVersion: '0.4.5' })

        const result = await moveWith({ ctx, flowVersion, seams })

        expect(result).toEqual({ flowVersion, moved: [], stayed: [] })
    })

    it('does not move a snapshot pin that has no metadata of its own', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['1.3.0-main.412'] })

        const result = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '1.3.0' }) })

        expect(result.moved).toEqual([])
        expect(result.stayed).toEqual([expect.objectContaining({ reason: 'snapshot-without-metadata' })])
    })

    it('moves every step on the pin, each with its own record, and leaves a step it cannot move', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2', '0.4.2'], otherQadamPin: '2.0.0' })
        const seams = fakeSeams({ imageVersion: '0.4.5' })

        const result = await moveWith({ ctx, flowVersion, seams })

        expect(result.moved.map((record) => record.stepName).sort()).toEqual(['step_1', 'step_2'])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_3', qadamName: OTHER_QADAM, reason: 'outside-caret' })])
        expect(pinsOf({ flowVersion: result.flowVersion })).toEqual(['0.4.5', '0.4.5'])
        expect(seams.imageBuild).toHaveBeenCalledTimes(2)
    })

    it('drops a step that was edited after the move was planned instead of overwriting the edit', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2', '0.4.2'] })
        const seams = fakeSeams({ imageVersion: '0.4.5' })
        seams.imageBuild.mockImplementation(async () => {
            const edited = JSON.parse(JSON.stringify(flowVersion.trigger))
            edited.nextAction.settings.qadamVersion = '0.4.3'
            await db.update('flow_version', flowVersion.id, { trigger: edited })
            return { build: { version: '0.4.5', load: { loaded: true } }, metadata: { image: true } }
        })

        const result = await moveWith({ ctx, flowVersion, seams })

        expect(result.moved.map((record) => record.stepName)).toEqual(['step_1'])
        expect(result.stayed).toEqual([expect.objectContaining({ stepName: 'step_2', reason: 'changed-meanwhile' })])
        expect(pinsOf({ flowVersion: result.flowVersion })).toEqual(['0.4.5', '0.4.3'])
    })

    it('refuses a flow that is not in the project and platform it is asked for', async () => {
        const owner = await createTestContext(app)
        const stranger = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx: owner, pins: ['0.4.2'] })

        await expect(moveWith({ ctx: stranger, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })).rejects.toMatchObject({ error: { code: 'ENTITY_NOT_FOUND', params: { entityType: 'flow' } } })
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('does not move it again after a person reverted it', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const first = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await qadamPinMoveService({ log: app.log }).revert({ id: first.moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })
        const reverted = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })

        const second = await moveWith({ ctx, flowVersion: reverted, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(second.moved).toEqual([])
        expect(second.stayed).toEqual([expect.objectContaining({ reason: 'reverted-by-user' })])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })
})

describe('qadamPinMoveService.revert', () => {
    it('puts the pin back and marks the record reverted, with who and when', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        const reverted = await qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })

        expect(reverted).toMatchObject({ id: moved[0].id, status: 'REVERTED', revertedBy: ctx.user.id })
        expect(reverted.revertedAt).not.toBeNull()
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
        expect(await db.findOneByOrFail<QadamPinMove>('qadam_pin_move', { id: moved[0].id })).toMatchObject({ status: 'REVERTED', fromVersion: '0.4.2', toVersion: '0.4.5' })
    })

    it('restores the old pin in a draft copied from the moved version and never touches a locked version', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved, flowVersion: movedVersion } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await db.update('flow_version', flowVersion.id, { state: FlowVersionState.LOCKED })
        await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })
        const draft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: movedVersion.trigger })
        await db.save('flow_version', draft)
        const editedDraft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: { ...movedVersion.trigger, settings: { ...movedVersion.trigger.settings, qadamVersion: '0.4.9' } } })
        await db.save('flow_version', editedDraft)

        const reverted = await qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })

        expect(reverted).toMatchObject({ status: 'REVERTED', publishRequired: true })
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: draft.id }) })).toEqual(['0.4.2'])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: editedDraft.id }) })).toEqual(['0.4.9'])
        const locked = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })
        expect(pinsOf({ flowVersion: locked })).toEqual(['0.4.5'])
        expect((await db.findOneByOrFail<{ publishedVersionId: string }>('flow', { id: flow.id })).publishedVersionId).toBe(flowVersion.id)
    })

    it('makes a draft from the published version when the flow has none, and leaves the published version as it is', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await db.update('flow_version', flowVersion.id, { state: FlowVersionState.LOCKED })
        await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })

        const reverted = await qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })

        expect(reverted.publishRequired).toBe(true)
        expect((await db.findOneByOrFail<{ publishedVersionId: string }>('flow', { id: flow.id })).publishedVersionId).toBe(flowVersion.id)
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
        const drafts = await db.find<FlowVersion>('flow_version', { flowId: flow.id, state: FlowVersionState.DRAFT })
        expect(drafts).toHaveLength(1)
        expect(pinsOf({ flowVersion: drafts[0] })).toEqual(['0.4.2'])
        expect(drafts[0].id).not.toBe(flowVersion.id)
    })

    it('refuses when neither a draft nor the published version carries the moved pin', async () => {
        const ctx = await createTestContext(app)
        const { flow, flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved, flowVersion: movedVersion } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await db.update('flow_version', flowVersion.id, { state: FlowVersionState.LOCKED })
        const differs = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.LOCKED, valid: true, trigger: { ...movedVersion.trigger, settings: { ...movedVersion.trigger.settings, qadamVersion: '0.4.9' } } })
        await db.save('flow_version', differs)
        await db.update('flow', flow.id, { publishedVersionId: differs.id })
        const editedDraft = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger: differs.trigger })
        await db.save('flow_version', editedDraft)

        await expect(qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })).rejects.toMatchObject({ error: { code: 'VALIDATION' } })

        expect(await db.findOneByOrFail<QadamPinMove>('qadam_pin_move', { id: moved[0].id })).toMatchObject({ status: 'APPLIED' })
    })

    it('does not move a locked version', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        await db.update('flow_version', flowVersion.id, { state: FlowVersionState.LOCKED })
        const locked = await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id })

        const result = await moveWith({ ctx, flowVersion: locked, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        expect(result.moved).toEqual([])
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('refuses a second revert', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })

        await expect(qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })).rejects.toMatchObject({ error: { code: 'VALIDATION' } })
    })

    it('refuses when the step has been changed since, and leaves the record applied', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved, flowVersion: movedVersion } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        const edited = JSON.parse(JSON.stringify(movedVersion.trigger))
        edited.settings.qadamVersion = '0.4.9'
        await db.update('flow_version', flowVersion.id, { trigger: edited })

        await expect(qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })).rejects.toMatchObject({ error: { code: 'VALIDATION' } })

        expect(await db.findOneByOrFail<QadamPinMove>('qadam_pin_move', { id: moved[0].id })).toMatchObject({ status: 'APPLIED' })
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.9'])
    })

    it('does not find another platform\'s record', async () => {
        const owner = await createTestContext(app)
        const stranger = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx: owner, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx: owner, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        await expect(qadamPinMoveService({ log: app.log }).revert({ id: moved[0].id, platformId: stranger.platform.id, userId: stranger.user.id })).rejects.toMatchObject({ error: { code: 'ENTITY_NOT_FOUND' } })
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
        expect(await db.findOneByOrFail<QadamPinMove>('qadam_pin_move', { id: moved[0].id })).toMatchObject({ status: 'APPLIED' })
    })
})

describe('/v1/qadam-pin-moves', () => {
    it('lists the platform\'s records, newest first, and filters by flow and status', async () => {
        const ctx = await createTestContext(app)
        const first = await seedFlow({ ctx, pins: ['0.4.2'] })
        const second = await seedFlow({ ctx, pins: ['0.4.1'] })
        const firstMove = await moveWith({ ctx, flowVersion: first.flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await moveWith({ ctx, flowVersion: second.flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })
        await qadamPinMoveService({ log: app.log }).revert({ id: firstMove.moved[0].id, platformId: ctx.platform.id, userId: ctx.user.id })

        const all = (await ctx.get('/v1/qadam-pin-moves')).json<SeekPage<QadamPinMove>>()
        const byFlow = (await ctx.get('/v1/qadam-pin-moves', { flowId: second.flow.id })).json<SeekPage<QadamPinMove>>()
        const reverted = (await ctx.get('/v1/qadam-pin-moves', { status: 'REVERTED' })).json<SeekPage<QadamPinMove>>()

        expect(all.data.map((record) => record.fromVersion)).toEqual(['0.4.1', '0.4.2'])
        expect(byFlow.data.map((record) => record.flowId)).toEqual([second.flow.id])
        expect(reverted.data.map((record) => record.id)).toEqual([firstMove.moved[0].id])
    })

    it('does not list or return another platform\'s records', async () => {
        const owner = await createTestContext(app)
        const stranger = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx: owner, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx: owner, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        const list = await stranger.get('/v1/qadam-pin-moves')
        const one = await stranger.get(`/v1/qadam-pin-moves/${moved[0].id}`)
        const revert = await stranger.post(`/v1/qadam-pin-moves/${moved[0].id}/revert`)

        expect(list.json<SeekPage<QadamPinMove>>().data).toEqual([])
        expect(one.statusCode).toBe(StatusCodes.NOT_FOUND)
        expect(revert.statusCode).toBe(StatusCodes.NOT_FOUND)
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.5'])
    })

    it('reads one record and reverts it', async () => {
        const ctx = await createTestContext(app)
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        const one = await ctx.get(`/v1/qadam-pin-moves/${moved[0].id}`)
        const revert = await ctx.post(`/v1/qadam-pin-moves/${moved[0].id}/revert`)
        const again = await ctx.post(`/v1/qadam-pin-moves/${moved[0].id}/revert`)

        expect(one.statusCode).toBe(StatusCodes.OK)
        expect(one.json<QadamPinMove>()).toMatchObject({ id: moved[0].id, status: 'APPLIED' })
        expect(revert.statusCode).toBe(StatusCodes.OK)
        expect(revert.json<QadamPinMove>()).toMatchObject({ status: 'REVERTED', revertedBy: ctx.user.id })
        expect(again.statusCode).toBe(StatusCodes.CONFLICT)
        expect(pinsOf({ flowVersion: await db.findOneByOrFail<FlowVersion>('flow_version', { id: flowVersion.id }) })).toEqual(['0.4.2'])
    })

    it('forbids a platform member who is not an admin', async () => {
        const ctx = await createTestContext(app)
        const { mockUser } = await mockBasicUser({ user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER } })
        const token = await generateMockToken({ id: mockUser.id, type: PrincipalType.USER, platform: { id: ctx.platform.id } })
        const headers = { authorization: `Bearer ${token}` }
        const { flowVersion } = await seedFlow({ ctx, pins: ['0.4.2'] })
        const { moved } = await moveWith({ ctx, flowVersion, seams: fakeSeams({ imageVersion: '0.4.5' }) })

        const list = await app.inject({ method: 'GET', url: '/api/v1/qadam-pin-moves', headers })
        const one = await app.inject({ method: 'GET', url: `/api/v1/qadam-pin-moves/${moved[0].id}`, headers })
        const revert = await app.inject({ method: 'POST', url: `/api/v1/qadam-pin-moves/${moved[0].id}/revert`, headers })

        expect([list.statusCode, one.statusCode, revert.statusCode]).toEqual([StatusCodes.FORBIDDEN, StatusCodes.FORBIDDEN, StatusCodes.FORBIDDEN])
    })
})

// A call as `qadamPinMoveService` makes it from a publish, against the fixture qadam's fake image.
function moveWith({ ctx, flowVersion, seams, actorUserId }: { ctx: TestContext, flowVersion: FlowVersion, seams: FakeSeams, actorUserId?: string }) {
    return qadamPinMoveService({ log: app.log, seams }).moveUnavailablePins(moveParams({ ctx, flowVersion, actorUserId }))
}

function moveParams({ ctx, flowVersion, actorUserId }: { ctx: TestContext, flowVersion: FlowVersion, actorUserId?: string }) {
    return { flowVersion, projectId: ctx.project.id, platformId: ctx.platform.id, cause: 'PUBLISH' as const, actorUserId }
}

function fakeSeams({ imageVersion, loaded = true, pinMetadata = { status: 'never-published' }, check = () => ({ compatible: true as const }) }: {
    imageVersion: string | null
    loaded?: boolean
    pinMetadata?: PinMetadata
    check?: PinFallbackSeams['propsChecker']['check']
}): FakeSeams {
    return {
        imageBuild: vi.fn(async ({ name }: { name: string }) => {
            if (name === OTHER_QADAM) {
                return { build: { version: '1.0.0', load: { loaded: true as const } }, metadata: { image: true } }
            }
            if (imageVersion === null || name !== QADAM) {
                return null
            }
            return { build: { version: imageVersion, load: loaded ? { loaded: true as const } : { loaded: false as const, reason: 'import.meta in CJS' } }, metadata: { image: true } }
        }),
        pinMetadata: vi.fn(async (): Promise<PinMetadata> => pinMetadata),
        propsChecker: { check },
    }
}

async function saveQadamVersion({ version }: { version: string }): Promise<void> {
    await db.save('qadam_metadata', createMockQadamMetadata({ name: QADAM, version, qadamType: QadamType.OFFICIAL, packageType: PackageType.REGISTRY }))
    await qadamCache(app.log).invalidate()
}

// A flow version whose trigger is `step_1`'s qadam, with one PIECE action per further pin
// (`step_2`, ...) and, last, an action on another qadam. `pins` are the fixture qadam's versions.
async function seedFlow({ ctx, pins, otherQadamPin, status = FlowStatus.DISABLED }: { ctx: TestContext, pins: string[], otherQadamPin?: string, status?: FlowStatus }): Promise<{ flow: { id: string }, flowVersion: FlowVersion }> {
    const flow = createMockFlow({ projectId: ctx.project.id, status })
    await db.save('flow', flow)
    const [first, ...rest] = pins
    const actions = [
        ...rest.map((pin, index) => pieceAction({ name: `step_${index + 2}`, qadamName: QADAM, qadamVersion: pin })),
        ...(otherQadamPin === undefined ? [] : [pieceAction({ name: `step_${rest.length + 2}`, qadamName: OTHER_QADAM, qadamVersion: otherQadamPin })]),
    ]
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
