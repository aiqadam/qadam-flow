import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ContextVersion, LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
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
import { QueryFailedError } from 'typeorm'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { frameworkCensusCache } from '../../../../src/app/qadams/census/framework-census-cache'
import { frameworkCensusMarking } from '../../../../src/app/qadams/census/framework-census-marking'
import { frameworkCensusPolicy } from '../../../../src/app/qadams/census/framework-census-policy'
import { frameworkCensusService } from '../../../../src/app/qadams/census/framework-census-service'
import { QadamMetadataSchema } from '../../../../src/app/qadams/metadata/qadam-metadata-entity'
import { qadamPinUtil } from '../../../../src/app/qadams/metadata/qadam-pin-util'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { withEngineContextVersions } from '../../../helpers/framework-census'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata, mockBasicUser } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Builds a test adds to what the image bundles, for the official path that has no metadata row.
const { extraBundled } = vi.hoisted(() => ({ extraBundled: [] as QadamMetadataSchema[] }))

vi.mock('../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: async (...args: Parameters<typeof actual.loadBundledQadams>) => [...await actual.loadBundledQadams(...args), ...extraBundled],
    }
})

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// The endpoint's cache outlives a test; a cached census must not answer for the next one.
afterEach(() => {
    frameworkCensusCache.clear()
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

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: async () => {
                const after = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

                expect(after.summary).toMatchObject({ current: 0, legacy: 0, unsupported: 1, flowsWithUnsupportedSteps: 1 })
                expect(after.steps).toHaveLength(1)
                expect(after.steps[0]).toMatchObject({ pin: 'census-v1-custom@1.0.0', status: 'unsupported' })
            },
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

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: async () => {
                const after = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })
                expect(after.summary).toMatchObject({ legacy: 0, unsupported: 2, flowsWithUnsupportedSteps: 2 })
            },
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

    // ADR-0002: an official qadam bundled in the image has no `qadam_metadata` row; its build's own
    // `package.json` is the record of the framework it was compiled against.
    it('resolves a bundled official pin from its build, with no qadam_metadata row', async () => {
        const ctx = await createTestContext(app!)
        const root = await mkdtemp(path.join(tmpdir(), 'census-bundled-'))
        try {
            extraBundled.push(
                await bundledBuild({ root, name: '@aiqadam/qadam-census-bundled', version: '0.3.0', frameworkSpec: 'workspace:*' }),
                await bundledBuild({ root, name: '@aiqadam/qadam-census-bundled-ahead', version: '0.1.0', frameworkSpec: '^99.0.0' }),
            )
            await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: '@aiqadam/qadam-census-bundled', qadamVersion: '0.3.0' })
            await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: '@aiqadam/qadam-census-bundled-ahead', qadamVersion: '0.1.0' })

            const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

            expect(await db.find('qadam_metadata', { name: '@aiqadam/qadam-census-bundled' })).toEqual([])
            // Built in this tree: the current major, which before 1.0.0 means context V2.
            expect(census.summary).toMatchObject({ current: 1, legacy: 1, unsupported: 0 })
            // Built against a major the support table does not list: unknown, which counts as
            // still needing the old contract.
            expect(census.steps).toEqual([expect.objectContaining({
                pin: '@aiqadam/qadam-census-bundled-ahead@0.1.0',
                source: 'official',
                frameworkMajor: 99,
                contextVersion: null,
                status: 'legacy',
            })])
        }
        finally {
            extraBundled.length = 0
            await rm(root, { recursive: true, force: true })
        }
    })

    // A flow batch is 100 flows; the keyset cursor must carry the census across batches.
    it('counts every flow of a platform with more flows than one batch', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        const flowIds = await saveDraftFlowsWithPinnedStep({ projectId: ctx.project.id, count: 205, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

        expect(census.summary).toMatchObject({ legacy: 205 })
        expect(new Set(census.steps.map((step) => step.flowId))).toEqual(new Set(flowIds))
    })

    // The doctor reads a database before the upgrade migrates it: a `qadam_metadata` that predates
    // `contextVersion` (#802) is an unknown context version, not an error.
    it('reads a database that predates contextVersion as an unknown context version', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
        const undefinedColumn = Object.assign(new Error('column QadamMetadataEntity.contextVersion does not exist'), { code: '42703' })
        const spy = vi.spyOn(databaseConnection().getRepository('qadam_metadata'), 'findOne')
            .mockRejectedValue(new QueryFailedError('SELECT', [], undefinedColumn))
        try {
            const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

            expect(census.steps).toEqual([expect.objectContaining({ source: 'custom', contextVersion: null, status: 'legacy' })])
        }
        finally {
            spy.mockRestore()
        }
    })

    // A timeout or a dropped connection is not "unknown": reading it as such would report a healthy
    // step as one that stops running once a shim is retired.
    it('fails on any other read error instead of reporting the step as unsupported', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v2-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V2,
        })
        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v2-custom', qadamVersion: '1.0.0' })
        const spy = vi.spyOn(databaseConnection().getRepository('qadam_metadata'), 'findOne')
            .mockRejectedValue(new Error('Connection terminated unexpectedly'))
        try {
            await withEngineContextVersions({
                contextVersions: [LATEST_CONTEXT_VERSION],
                run: async () => {
                    await expect(frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id }))
                        .rejects.toThrow('Connection terminated unexpectedly')
                },
            })
        }
        finally {
            spy.mockRestore()
        }
    })

    // #838: a flow version whose step tree cannot be walked is in no count, so the census carries
    // how many there were — per platform and for the whole instance — for the doctor to report.
    it('counts a flow version it cannot read as unreadable, per platform and for the instance', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
        await saveUnreadableFlowVersion({ projectId: ctx.project.id })

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })
        expect(census.unreadableVersions).toBe(1)
        expect(census.summary).toMatchObject({ current: 0, legacy: 1, unsupported: 0 })

        const instance = await frameworkCensusService(mockLog).censusOfInstance()
        const platform = instance.platforms.find((candidate) => candidate.platformId === ctx.platform.id)
        expect(platform?.unreadableVersions).toBe(1)
        expect(instance.unreadableVersions).toBe(instance.platforms.reduce((total, candidate) => total + candidate.unreadableVersions, 0))
        expect(instance.unreadableVersions).toBeGreaterThanOrEqual(1)
    })

    // #838: the census counts as it walks and keeps at most `maxSteps` steps, unsupported first,
    // while the summary and `totalSteps` still count every occurrence.
    it('caps the kept steps at maxSteps, unsupported first, and still counts every occurrence', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({
            name: 'census-v1-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V1,
        })
        await saveQadamRow({
            name: 'census-none-custom',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: 'NONE',
        })
        await saveDraftFlowsWithPinnedStep({ projectId: ctx.project.id, count: 3, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
        await saveDraftFlowsWithPinnedStep({ projectId: ctx.project.id, count: 2, qadamName: 'census-none-custom', qadamVersion: '1.0.0' })

        // A release that retired only the pre-`getContextInfo` shim: V1 still runs on its shim.
        await withEngineContextVersions({
            contextVersions: [ContextVersion.V1, LATEST_CONTEXT_VERSION],
            run: async () => {
                const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id, maxSteps: 3 })

                expect(census.summary).toMatchObject({ legacy: 3, unsupported: 2, flowsWithUnsupportedSteps: 2 })
                expect(census.totalSteps).toBe(5)
                expect(census.steps.map((step) => step.status)).toEqual(['unsupported', 'unsupported', 'legacy'])
            },
        })
    })

    // #838 (the deviation from the ticket's nit): a pin some version answers is not `unresolved`,
    // even when no row of the expected type records that version's context version. Its context is
    // unknown, which ADR-0002 counts as still needing the old contract — and the MCP marking, which
    // skips only `unresolved` pins, still marks it.
    it('keeps a pin that resolves but has no context record official/custom with an unknown context, and marks it', async () => {
        const ctx = await createTestContext(app!)
        // Resolves through the registry (a platform row), but no official row records it.
        await saveQadamRow({
            name: '@aiqadam/qadam-census-stray',
            version: '1.0.0',
            platformId: ctx.platform.id,
            qadamType: QadamType.CUSTOM,
            contextVersion: ContextVersion.V2,
        })
        // Resolves through the registry (an official row), but no custom row records it.
        await saveQadamRow({
            name: 'census-official-typed',
            version: '1.0.0',
            platformId: null,
            qadamType: QadamType.OFFICIAL,
            contextVersion: ContextVersion.V2,
        })
        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: '@aiqadam/qadam-census-stray', qadamVersion: '1.0.0' })
        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-official-typed', qadamVersion: '1.0.0' })

        const census = await frameworkCensusService(mockLog).censusOfPlatform({ platformId: ctx.platform.id })

        expect(census.summary).toMatchObject({ current: 0, legacy: 2, unsupported: 0 })
        expect(census.steps.map((step) => ({ pin: step.pin, source: step.source, contextVersion: step.contextVersion })).sort((a, b) => a.pin.localeCompare(b.pin))).toEqual([
            { pin: '@aiqadam/qadam-census-stray@1.0.0', source: 'official', contextVersion: null },
            { pin: 'census-official-typed@1.0.0', source: 'custom', contextVersion: null },
        ])

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: async () => {
                const qadamSteps = [
                    ...qadamPinUtil.getQadamSteps({ trigger: pinnedTrigger({ qadamName: '@aiqadam/qadam-census-stray', qadamVersion: '1.0.0' }) }),
                    ...qadamPinUtil.getQadamSteps({ trigger: pinnedTrigger({ qadamName: 'census-official-typed', qadamVersion: '1.0.0' }) }),
                    ...qadamPinUtil.getQadamSteps({ trigger: pinnedTrigger({ qadamName: 'census-missing-custom', qadamVersion: '1.0.0' }) }),
                ]
                const marked = await frameworkCensusMarking(mockLog).unsupportedPins({ qadamSteps, platformId: ctx.platform.id })

                // The two resolving pins are marked; the pin nothing answers is left to `qadam_version`.
                expect([...marked.keys()].sort()).toEqual(['@aiqadam/qadam-census-stray@1.0.0', 'census-official-typed@1.0.0'])
            },
        })
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

            // Nothing retired: no step can be unsupported, so the platform's flows are not walked —
            // the legacy step is the doctor's to list, not this surface's.
            const before = await ctx.get('/v1/framework-census')
            expect(before.statusCode).toBe(StatusCodes.OK)
            const beforeBody = before.json<FrameworkCensusResponse>()
            expect(beforeBody.engine.contextVersions).toContain(LATEST_CONTEXT_VERSION)
            expect(beforeBody.retiredContextVersions).toEqual([])
            expect(beforeBody.ran).toBe(false)
            expect(beforeBody.summary).toEqual({ current: 0, legacy: 0, unsupported: 0, flowsWithUnsupportedSteps: 0 })
            expect(beforeBody.totalSteps).toBe(0)
            expect(beforeBody.steps).toEqual([])

            await withEngineContextVersions({
                contextVersions: [LATEST_CONTEXT_VERSION],
                run: async () => {
                    const after = await ctx.get('/v1/framework-census')
                    const afterBody = after.json<FrameworkCensusResponse>()
                    expect(afterBody.ran).toBe(true)
                    expect(afterBody.retiredContextVersions).toEqual(['none', '1'])
                    expect(afterBody.summary).toMatchObject({ legacy: 0, unsupported: 1, flowsWithUnsupportedSteps: 1 })
                    expect(afterBody.totalSteps).toBe(1)
                    expect(afterBody.steps[0]).toMatchObject({ pin: 'census-v1-custom@1.0.0', status: 'unsupported' })
                },
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

            await withEngineContextVersions({
                contextVersions: [LATEST_CONTEXT_VERSION],
                run: async () => {
                    const response = await mine.get('/v1/framework-census')
                    const body = response.json<FrameworkCensusResponse>()

                    expect(body.steps).toHaveLength(1)
                    expect(body.steps[0].projectId).toBe(mine.project.id)
                },
            })
        })

        // #838: once something is retired every request walks the platform, so the endpoint answers
        // from a per-platform cache and concurrent requests share one walk.
        it('walks the platform once for concurrent requests and serves later ones from the cache', async () => {
            const ctx = await createTestContext(app!)
            await saveQadamRow({
                name: 'census-v1-custom',
                version: '1.0.0',
                platformId: ctx.platform.id,
                qadamType: QadamType.CUSTOM,
                contextVersion: ContextVersion.V1,
            })
            await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
            // Count walks at the cache's compute: each call of it is one census of the platform.
            const ofPlatform = frameworkCensusCache.ofPlatform
            let walks = 0
            const spy = vi.spyOn(frameworkCensusCache, 'ofPlatform').mockImplementation(({ platformId, compute }) => ofPlatform({
                platformId,
                compute: () => {
                    walks += 1
                    return compute()
                },
            }))
            try {
                await withEngineContextVersions({
                    contextVersions: [LATEST_CONTEXT_VERSION],
                    run: async () => {
                        const [first, second] = await Promise.all([ctx.get('/v1/framework-census'), ctx.get('/v1/framework-census')])
                        expect(first.json<FrameworkCensusResponse>().summary).toMatchObject({ unsupported: 1 })
                        expect(second.json<FrameworkCensusResponse>().summary).toMatchObject({ unsupported: 1 })
                        expect(walks).toBe(1)

                        // A step added within the TTL is not seen yet: the census is a report, and
                        // a few minutes of staleness is the price of a bounded cost.
                        await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
                        const cached = (await ctx.get('/v1/framework-census')).json<FrameworkCensusResponse>()
                        expect(cached.summary).toMatchObject({ unsupported: 1 })
                        expect(walks).toBe(1)

                        frameworkCensusCache.clear()
                        const fresh = (await ctx.get('/v1/framework-census')).json<FrameworkCensusResponse>()
                        expect(fresh.summary).toMatchObject({ unsupported: 2 })
                        expect(walks).toBe(2)
                    },
                })
            }
            finally {
                spy.mockRestore()
            }
        })

        it('caps the step list and reports the total', async () => {
            const ctx = await createTestContext(app!)
            await saveQadamRow({
                name: 'census-v1-custom',
                version: '1.0.0',
                platformId: ctx.platform.id,
                qadamType: QadamType.CUSTOM,
                contextVersion: ContextVersion.V1,
            })
            await saveDraftFlowsWithPinnedStep({ projectId: ctx.project.id, count: 205, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })

            await withEngineContextVersions({
                contextVersions: [LATEST_CONTEXT_VERSION],
                run: async () => {
                    const body = (await ctx.get('/v1/framework-census')).json<FrameworkCensusResponse>()

                    expect(body.summary).toMatchObject({ unsupported: 205, flowsWithUnsupportedSteps: 205 })
                    expect(body.totalSteps).toBe(205)
                    expect(body.steps).toHaveLength(200)
                },
            })
        })
    })
})


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

// A flow version whose step tree the census cannot walk: a router whose `children` is not a list.
async function saveUnreadableFlowVersion({ projectId }: { projectId: string }): Promise<void> {
    const flow = createMockFlow({ projectId, status: FlowStatus.DISABLED, publishedVersionId: null })
    await db.save('flow', flow)
    const version = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.DRAFT })
    await databaseConnection().getRepository('flow_version').insert({
        ...version,
        trigger: {
            ...pinnedTrigger({ qadamName: 'census-v1-custom', qadamVersion: '1.0.0' }),
            nextAction: { type: 'ROUTER', name: 'step_1', displayName: 'Broken Router', valid: true, children: 'not-a-list', settings: {} },
        },
    })
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

// The flow → flow_version FK runs both ways, so the flows go in first, unpublished; each one's only
// version is then its latest, counted as a draft.
async function saveDraftFlowsWithPinnedStep({ projectId, count, qadamName, qadamVersion }: {
    projectId: string
    count: number
    qadamName: string
    qadamVersion: string
}): Promise<string[]> {
    const flows = Array.from({ length: count }, () => createMockFlow({ projectId, status: FlowStatus.DISABLED, publishedVersionId: null }))
    await db.save('flow', flows)
    await db.save('flow_version', flows.map((flow) => createMockFlowVersion({
        flowId: flow.id,
        created: '2026-01-01T00:00:00.000Z',
        state: FlowVersionState.DRAFT,
        trigger: pinnedTrigger({ qadamName, qadamVersion }),
    })))
    return flows.map((flow) => flow.id)
}

async function bundledBuild({ root, name, version, frameworkSpec }: {
    root: string
    name: string
    version: string
    frameworkSpec: string
}): Promise<QadamMetadataSchema> {
    const directoryPath = path.join(root, name.replace('/', '__'))
    await mkdir(directoryPath, { recursive: true })
    await writeFile(path.join(directoryPath, 'package.json'), JSON.stringify({
        name,
        version,
        dependencies: { '@aiqadam/qadams-framework': frameworkSpec },
    }))
    return {
        ...createMockQadamMetadata({ name, version, qadamType: QadamType.OFFICIAL, packageType: PackageType.REGISTRY, directoryPath }),
        platformId: undefined,
    }
}

// The builder's per-flow read of the census (#803): project scoped, and bounded to one flow version.
describe('GET /v1/framework-census/flow-version (#803)', () => {
    it('names the steps of the version a retirement stopped running, and nothing while no shim is retired', async () => {
        const ctx = await createTestContext(app!)
        await saveQadamRow({ name: 'census-v1-custom', version: '1.0.0', platformId: ctx.platform.id, qadamType: QadamType.CUSTOM, contextVersion: ContextVersion.V1 })
        const flowId = await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
        const flow = await db.findOneByOrFail<{ publishedVersionId: string }>('flow', { id: flowId })

        const before = await ctx.get('/v1/framework-census/flow-version', { flowId, flowVersionId: flow.publishedVersionId })
        expect(before.statusCode).toBe(StatusCodes.OK)
        expect(before.json<{ unsupportedStepNames: string[] }>().unsupportedStepNames).toEqual([])

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: async () => {
                const after = await ctx.get('/v1/framework-census/flow-version', { flowId, flowVersionId: flow.publishedVersionId })
                expect(after.statusCode).toBe(StatusCodes.OK)
                expect(after.json<{ unsupportedStepNames: string[] }>().unsupportedStepNames).toEqual(['trigger'])
            },
        })
    })

    it('answers nothing for a version that is not the flow\'s, and refuses a flow of a project the caller is not in', async () => {
        const ctx = await createTestContext(app!)
        const other = await createTestContext(app!)
        await saveQadamRow({ name: 'census-v1-custom', version: '1.0.0', platformId: other.platform.id, qadamType: QadamType.CUSTOM, contextVersion: ContextVersion.V1 })
        const otherFlowId = await saveFlowWithPinnedStep({ projectId: other.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })
        const otherFlow = await db.findOneByOrFail<{ publishedVersionId: string }>('flow', { id: otherFlowId })
        const ownFlowId = await saveFlowWithPinnedStep({ projectId: ctx.project.id, qadamName: 'census-v1-custom', qadamVersion: '1.0.0' })

        await withEngineContextVersions({
            contextVersions: [LATEST_CONTEXT_VERSION],
            run: async () => {
                const foreign = await ctx.get('/v1/framework-census/flow-version', { flowId: otherFlowId, flowVersionId: otherFlow.publishedVersionId })
                expect(foreign.statusCode).toBe(StatusCodes.FORBIDDEN)

                const mismatched = await ctx.get('/v1/framework-census/flow-version', { flowId: ownFlowId, flowVersionId: otherFlow.publishedVersionId })
                expect(mismatched.statusCode).toBe(StatusCodes.OK)
                expect(mismatched.json<{ unsupportedStepNames: string[] }>().unsupportedStepNames).toEqual([])
            },
        })
    })
})
