import {
    apId,
    PackageType,
    PrincipalType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { qadamCache } from '../../../../src/app/qadams/metadata/qadam-cache'
import { filterQadamBasedOnType, isSupportedRelease } from '../../../../src/app/qadams/metadata/utils'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// @aiqadam/qadam-webhook is built at packages/qadams/core/webhook/dist and is
// always available as a bundled qadam. Tests that use this name avoid the raw-SQL
// alias limitation that affects non-bundled DB-only entries.
const BUNDLED_QADAM_NAME = '@aiqadam/qadam-webhook'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('qadam_metadata').createQueryBuilder().delete().execute()
})

describe('Qadam resolution and platform-scoped filtering', () => {
    describe('GET /v1/qadams — list returns non-empty result', () => {
        it('returns an array with at least one entry when bundled qadams are available', async () => {
            await qadamCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/qadams',
                headers: { authorization: `Bearer ${testToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(Array.isArray(body)).toBe(true)
            expect(body.length).toBeGreaterThan(0)
        })
    })

    describe('GET /v1/qadams/:scope/:name — specific qadam lookup', () => {
        it('returns the bundled qadam by scoped name', async () => {
            await qadamCache(mockLog).setup()

            const ctx = await createTestContext(app!)
            const response = await ctx.get('/v1/qadams/@aiqadam/qadam-webhook')

            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json()
            expect(body.name).toBe(BUNDLED_QADAM_NAME)
            // Version is not pinned: the bundled version on disk is the source of truth.
            expect(typeof body.version).toBe('string')
        })

        it('returns 404 for a qadam name that does not exist in the registry', async () => {
            await qadamCache(mockLog).setup()

            const ctx = await createTestContext(app!)
            const response = await ctx.get('/v1/qadams/@aiqadam/qadam-does-not-exist-xyz')

            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('returns 404 when the only available version has an incompatible minimumSupportedRelease', async () => {
            const incompatible = createMockQadamMetadata({
                name: '@aiqadam/qadam-all-incompatible-versions',
                version: '0.1.0',
                qadamType: QadamType.OFFICIAL,
                packageType: PackageType.REGISTRY,
                minimumSupportedRelease: '99.0.0',
                maximumSupportedRelease: '99999.99999.9999',
            })
            await db.save('qadam_metadata', incompatible)
            await qadamCache(mockLog).setup()

            const ctx = await createTestContext(app!)
            const response = await ctx.get('/v1/qadams/@aiqadam/qadam-all-incompatible-versions')

            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('Version resolution logic — isSupportedRelease utility', () => {
        // The version compatibility check is the core of version resolution.
        // We verify the utility directly because the HTTP/service path requires the
        // registry lookup, which is a cached/raw-query path tested elsewhere.

        it('marks a qadam compatible when the release falls within its supported range', () => {
            const metadata = createMockQadamMetadata({
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '99999.99999.9999',
            })

            expect(isSupportedRelease('0.20.0', metadata)).toBe(true)
        })

        it('marks a qadam incompatible when the release is below minimumSupportedRelease', () => {
            const metadata = createMockQadamMetadata({
                minimumSupportedRelease: '99.0.0',
                maximumSupportedRelease: '99999.99999.9999',
            })

            expect(isSupportedRelease('0.20.0', metadata)).toBe(false)
        })

        it('marks a qadam incompatible when the release is above maximumSupportedRelease', () => {
            const metadata = createMockQadamMetadata({
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '0.5.0',
            })

            expect(isSupportedRelease('1.0.0', metadata)).toBe(false)
        })
    })

    describe('Platform-scoped filtering logic — filterQadamBasedOnType utility', () => {
        it('includes an OFFICIAL qadam with no platformId for any context (undefined or set)', () => {
            const officialEntry = createMockQadamMetadata({
                qadamType: QadamType.OFFICIAL,
                platformId: undefined,
            })

            // Visible with no platform context.
            expect(filterQadamBasedOnType(undefined, officialEntry)).toBe(true)
            // Visible within a platform context.
            expect(filterQadamBasedOnType(apId(), officialEntry)).toBe(true)
        })

        it('excludes a CUSTOM qadam when no platformId is provided', () => {
            const platformId = apId()
            const customEntry = createMockQadamMetadata({
                qadamType: QadamType.CUSTOM,
                platformId,
            })

            expect(filterQadamBasedOnType(undefined, customEntry)).toBe(false)
        })

        it('includes a CUSTOM qadam only for the matching platformId', () => {
            const platformA = apId()
            const platformB = apId()
            const customEntry = createMockQadamMetadata({
                qadamType: QadamType.CUSTOM,
                platformId: platformA,
            })

            expect(filterQadamBasedOnType(platformA, customEntry)).toBe(true)
            expect(filterQadamBasedOnType(platformB, customEntry)).toBe(false)
        })
    })

    describe('GET /v1/qadams list — platform context', () => {
        it('includes the bundled official qadam for every platform context', async () => {
            await qadamCache(mockLog).setup()

            const ctxA = await createTestContext(app!)
            const ctxB = await createTestContext(app!)

            const responseA = await ctxA.get('/v1/qadams')
            const responseB = await ctxB.get('/v1/qadams')

            expect(responseA.statusCode).toBe(StatusCodes.OK)
            expect(responseB.statusCode).toBe(StatusCodes.OK)

            const namesA: string[] = responseA.json().map((p: { name: string }) => p.name)
            const namesB: string[] = responseB.json().map((p: { name: string }) => p.name)

            expect(namesA).toContain(BUNDLED_QADAM_NAME)
            expect(namesB).toContain(BUNDLED_QADAM_NAME)
        })

        it('filters the list to only official qadams for an UNKNOWN (non-platform) principal', async () => {
            await qadamCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/qadams',
                headers: { authorization: `Bearer ${testToken}` },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body: Array<{ qadamType: string, platformId: string | null }> = response?.json()
            // No CUSTOM qadams should appear for an UNKNOWN principal.
            expect(body.every((p) => p.qadamType === QadamType.OFFICIAL)).toBe(true)
        })
    })
})
