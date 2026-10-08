import { ContextVersion, FrameworkContextVersion, LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import {
    FlowStatus,
    FlowTrigger,
    FlowTriggerType,
    FlowVersionState,
    FrameworkCensusResponse,
    PackageType,
    PlatformRole,
    PrincipalType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { MockInstance } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { frameworkCensusPolicy } from '../../../../src/app/qadams/census/framework-census-policy'
import { frameworkCensusService } from '../../../../src/app/qadams/census/framework-census-service'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata, mockBasicUser } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// ADR-0002's census (#803). The ticket's scenario is test 1: a step pinned to a context-V1 custom
// qadam is listed before the retirement and marked after it, and its flow stays enabled.
describe('framework-major census (#803)', () => {
    it('lists a context-V1 custom pin before the retirement and marks it after it; the flow stays enabled', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        const flowId = await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: 'census-v1-custom',
            qadamVersion: '1.0.0',
            status: FlowStatus.ENABLED,
        })

        const before = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

        expect(before.summary).toMatchObject({ current: 0, legacy: 1, unsupported: 0, flowsWithUnsupportedSteps: 0 })
        expect(before.steps).toHaveLength(1)
        expect(before.steps[0]).toMatchObject({
            pin: 'census-v1-custom@1.0.0',
            source: 'custom',
            contextVersion: ContextVersion.V1,
            status: 'legacy',
            flowId,
            flowStatus: FlowStatus.ENABLED,
            version: 'published',
        })

        await withRetiredContextVersion([LATEST_CONTEXT_VERSION], async () => {
            const after = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

            expect(after.summary).toMatchObject({ current: 0, legacy: 0, unsupported: 1, flowsWithUnsupportedSteps: 1 })
            expect(after.steps).toHaveLength(1)
            expect(after.steps[0]).toMatchObject({ pin: 'census-v1-custom@1.0.0', status: 'unsupported' })
        })

        // The census never disables a flow (#435): it only reports.
        const flow = await db.findOneByOrFail<{ status: string }>('flow', { id: flowId })
        expect(flow.status).toBe(FlowStatus.ENABLED)
    })

    it('counts an unknown context version and an unresolvable pin as still needing the old contract, and marks both once the shim is gone', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-unknown-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: null,
        })
        await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: 'census-unknown-custom',
            qadamVersion: '1.0.0',
        })
        await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: 'census-missing-custom',
            qadamVersion: '1.0.0',
        })

        const before = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })
        expect(before.summary).toMatchObject({ legacy: 2, unsupported: 0 })
        expect(before.steps.map((step) => step.source).sort()).toEqual(['custom', 'unresolved'])

        await withRetiredContextVersion([LATEST_CONTEXT_VERSION], async () => {
            const after = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })
            expect(after.summary).toMatchObject({ legacy: 0, unsupported: 2, flowsWithUnsupportedSteps: 2 })
        })
    })

    it('resolves an official pin through the stored official row and leaves a V2 pin current', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: '@aiqadam/qadam-census-official-v2',
            version: '1.0.0',
            platformId: null,
            qadamType: QadamType.OFFICIAL,
            contextVersion: ContextVersion.V2,
        })
        await saveQadamRow({
            name: '@aiqadam/qadam-census-official-v1',
            version: '1.0.0',
            platformId: null,
            qadamType: QadamType.OFFICIAL,
            contextVersion: ContextVersion.V1,
        })
        await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: '@aiqadam/qadam-census-official-v2',
            qadamVersion: '1.0.0',
        })
        await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: '@aiqadam/qadam-census-official-v1',
            qadamVersion: '1.0.0',
        })

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

        expect(census.summary).toMatchObject({ current: 1, legacy: 1, unsupported: 0 })
        expect(census.steps).toHaveLength(1)
        expect(census.steps[0]).toMatchObject({
            pin: '@aiqadam/qadam-census-official-v1@1.0.0',
            source: 'official',
            contextVersion: ContextVersion.V1,
            status: 'legacy',
        })
    })

    it('counts the published and the latest version of a flow separately, deduped when they are the same', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        await saveQadamRow({
            name: 'census-v2-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V2,
        })
        const flowId = await saveFlowWithPinnedStep({
            projectId: ctx.project.id,
            qadamName: 'census-v1-custom',
            qadamVersion: '1.0.0',
            status: FlowStatus.ENABLED,
        })
        const draft = createMockFlowVersion({
            flowId,
            created: '2026-01-02T00:00:00.000Z',
            trigger: pinnedTrigger({ qadamName: 'census-v2-custom', qadamVersion: '1.0.0' }),
        })
        await db.save('flow_version', draft)

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

        // The published V1 step and the draft V2 step are two occurrences: one legacy, one current.
        expect(census.summary).toMatchObject({ current: 1, legacy: 1 })
        expect(census.steps).toHaveLength(1)
        expect(census.steps[0]).toMatchObject({ version: 'published', pin: 'census-v1-custom@1.0.0', status: 'legacy' })
    })

    it('keeps another platform\'s flows out of the census', async () => {
        const mine = await createTestContext(app!)
        const other = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: mine.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        await saveFlowWithPinnedStep({
            projectId: mine.project.id,
            qadamName: 'census-v1-custom',
            qadamVersion: '1.0.0',
        })
        await saveFlowWithPinnedStep({
            projectId: other.project.id,
            qadamName: 'census-v1-custom',
            qadamVersion: '1.0.0',
        })

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: mine.platform.id })

        expect(census.steps).toHaveLength(1)
        expect(census.steps[0].projectId).toBe(mine.project.id)
    })

    it('reports the engine\'s framework major and context versions in the instance census', async () => {
        const census = await frameworkCensusService(mockLog).censusOfInstance()

        expect(census.engine.frameworkMajor).toBe(frameworkCensusPolicy.currentFrameworkMajor())
        expect(census.engine.contextVersions).toContain(LATEST_CONTEXT_VERSION)
    })

    describe('GET /v1/framework-census (admin surface)', () => {
        it('returns the platform\'s census and marks steps once the shim is retired', async () => {
            const ctx = await createTestContext(app!)
            await saveQadamRow({
                name: 'census-v1-custom',
                version: '1.0.0',
                platformId: ctx.platform.id,
                qadamType: QadamType.CUSTOM,
                contextVersion: ContextVersion.V1,
            })
            await saveFlowWithPinnedStep({
                projectId: ctx.project.id,
                qadamName: 'census-v1-custom',
                qadamVersion: '1.0.0',
            })

            const before = await ctx.get('/v1/framework-census')
            expect(before.statusCode).toBe(StatusCodes.OK)
            const beforeBody = before.json<FrameworkCensusResponse>()
            expect(beforeBody.engine.contextVersions).toContain(LATEST_CONTEXT_VERSION)
            expect(beforeBody.retiredContextVersions).toEqual([])
            expect(beforeBody.summary).toMatchObject({ legacy: 1, unsupported: 0 })
            expect(beforeBody.steps).toHaveLength(1)

            await withRetiredContextVersion([LATEST_CONTEXT_VERSION], async () => {
                const after = await ctx.get('/v1/framework-census')
                const afterBody = after.json<FrameworkCensusResponse>()
                expect(afterBody.retiredContextVersions).toEqual(['none', '1'])
                expect(afterBody.summary).toMatchObject({ legacy: 0, unsupported: 1, flowsWithUnsupportedSteps: 1 })
                expect(afterBody.steps[0]).toMatchObject({ pin: 'census-v1-custom@1.0.0', status: 'unsupported' })
            })
        })

        it('forbids a platform member who is not a platform admin', async () => {
            const ctx = await createTestContext(app!)
            const { mockUser } = await mockBasicUser({
                user: {
                    platformId: ctx.platform.id,
                    platformRole: PlatformRole.MEMBER,
                },
            })
            const memberToken = await generateMockToken({
                id: mockUser.id,
                type: PrincipalType.USER,
                platform: { id: ctx.platform.id },
            })

            const response = await app!.inject({
                method: 'GET',
                url: '/api/v1/framework-census',
                headers: { authorization: `Bearer ${memberToken}` },
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })

        it('never returns another platform\'s flows', async () => {
            const mine = await createTestContext(app!)
            const other = await createTestContext(app!)
            await saveQadamRow({
                name: 'census-v1-custom',
                version: '1.0.0',
                platformId: mine.platform.id,
                qadamType: QadamType.CUSTOM,
                contextVersion: ContextVersion.V1,
            })
            await saveFlowWithPinnedStep({
                projectId: mine.project.id,
                qadamName: 'census-v1-custom',
                qadamVersion: '1.0.0',
            })
            await saveFlowWithPinnedStep({
                projectId: other.project.id,
                qadamName: 'census-v1-custom',
                qadamVersion: '1.0.0',
            })

            const response = await mine.get('/v1/framework-census')
            const body = response.json<FrameworkCensusResponse>()

            expect(body.steps).toHaveLength(1)
            expect(body.steps[0].projectId).toBe(mine.project.id)
        })
    })
})

// A stand-in for a release that has retired shims: the census reads the engine's supported set
// through `engineContextVersions()` exactly so a test can drop one without touching the engine.
async function withRetiredContextVersion(contextVersions: FrameworkContextVersion[], run: () => Promise<void>): Promise<void> {
    const spy: MockInstance = vi.spyOn(frameworkCensusPolicy, 'engineContextVersions').mockReturnValue(contextVersions)
    try {
        await run()
    }
    finally {
        spy.mockRestore()
    }
}

function pinnedTrigger({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }): FlowTrigger {
    return {
        type: FlowTriggerType.PIECE,
        name: 'trigger',
        displayName: 'Census Trigger',
        valid: true,
        lastUpdatedDate: '2026-01-01T00:00:00.000Z',
        settings: {
            qadamName,
            qadamVersion,
            triggerName: 'new_item',
            input: {},
            propertySettings: {},
        },
    }
}

async function saveFlowWithPinnedStep({ projectId, qadamName, qadamVersion, status = FlowStatus.DISABLED }: {
    projectId: string
    qadamName: string
    qadamVersion: string
    status?: FlowStatus
}): Promise<string> {
    const flow = createMockFlow({ projectId, status, publishedVersionId: null })
    const version = createMockFlowVersion({
        flowId: flow.id,
        created: '2026-01-01T00:00:00.000Z',
        state: FlowVersionState.LOCKED,
        trigger: pinnedTrigger({ qadamName, qadamVersion }),
    })
    // The FK points flow → flow_version, so the flow is inserted first and the pin updated after.
    await db.save('flow', flow)
    await db.save('flow_version', version)
    await db.update('flow', flow.id, { publishedVersionId: version.id })
    return flow.id
}

async function saveQadamRow({ name, version, platformId, qadamType, contextVersion }: {
    name: string
    version: string
    platformId: string | null
    qadamType: QadamType
    contextVersion: string | null
}): Promise<void> {
    const row = createMockQadamMetadata({
        name,
        version,
        platformId: platformId ?? undefined,
        qadamType,
        packageType: PackageType.REGISTRY,
    })
    await databaseConnection().getRepository('qadam_metadata').insert({ ...row, contextVersion })
}
