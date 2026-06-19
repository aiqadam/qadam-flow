import {
    AppConnectionType,
    ApplicationEventName,
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import * as applicationEventsModule from '../../../../src/app/helper/application-events'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { actionsEmitted } from '../../../helpers/application-events'
import { db } from '../../../helpers/db'
import { createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let mockLog: FastifyBaseLogger
const originalApplicationEvents = applicationEventsModule.applicationEvents

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
    mockLog = app.log
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('App connection application events', () => {
    let sendUserEventSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
        sendUserEventSpy = vi.fn()
        vi.spyOn(applicationEventsModule, 'applicationEvents').mockImplementation((log) => {
            const real = originalApplicationEvents(log)
            return {
                ...real,
                sendUserEvent: sendUserEventSpy,
            }
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('emits CONNECTION_UPSERTED on POST /v1/app-connections', async () => {
        const ctx = await createTestContext(app)
        const piece = await seedQadamMetadata(ctx)

        const response = await ctx.post('/v1/app-connections', {
            externalId: 'event-test-connection',
            displayName: 'Event Test Connection',
            qadamName: piece.name,
            projectId: ctx.project.id,
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'my-secret',
            },
            qadamVersion: piece.version,
        })

        expect(response?.statusCode).toBe(StatusCodes.CREATED)
        expect(actionsEmitted(sendUserEventSpy)).toEqual([
            ApplicationEventName.CONNECTION_UPSERTED,
        ])
    })

    it('emits CONNECTION_DELETED on DELETE /v1/app-connections/:id', async () => {
        const ctx = await createTestContext(app)
        const piece = await seedQadamMetadata(ctx)

        const createResponse = await ctx.post('/v1/app-connections', {
            externalId: 'event-test-connection-to-delete',
            displayName: 'Event Test Connection',
            qadamName: piece.name,
            projectId: ctx.project.id,
            type: AppConnectionType.SECRET_TEXT,
            value: {
                type: AppConnectionType.SECRET_TEXT,
                secret_text: 'my-secret',
            },
            qadamVersion: piece.version,
        })
        expect(createResponse?.statusCode).toBe(StatusCodes.CREATED)
        const connectionId = createResponse?.json().id

        sendUserEventSpy.mockClear()

        const response = await ctx.delete(`/v1/app-connections/${connectionId}`)

        expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
        expect(actionsEmitted(sendUserEventSpy)).toEqual([
            ApplicationEventName.CONNECTION_DELETED,
        ])
    })
})

async function seedQadamMetadata(ctx: TestContext): Promise<{ name: string, version: string }> {
    const piece = createMockQadamMetadata({
        platformId: ctx.platform.id,
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
    })
    await db.save('qadam_metadata', piece)
    qadamMetadataService(mockLog).getOrThrow = vi.fn().mockResolvedValue(piece)
    return { name: piece.name, version: piece.version }
}

