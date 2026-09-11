import {
    AppConnectionType,
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { SystemJobName } from '../../../../src/app/helper/system-jobs/common'
import * as systemJobModule from '../../../../src/app/helper/system-jobs/system-job'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { db } from '../../../helpers/db'
import { createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
    mockLog = app.log
})

afterAll(async () => {
    await teardownTestEnvironment()
})

/**
 * The hook that registers or removes the webhook at the third party runs only when a flow is
 * enabled, so every route that can change a connection's delivery mode has to re-run it. Missing one
 * leaves the flow reading "on" while receiving nothing, with no error anywhere — and one *was*
 * missed in review: the selector sits on the reconnect dialog, which submits through `upsert`, while
 * only `update` re-ran the hook. These cover the wiring; the fan-out itself is covered by unit tests.
 */
describe('Delivery-mode changes re-run the trigger hooks', () => {
    let upsertJob: ReturnType<typeof vi.fn>

    beforeEach(() => {
        upsertJob = vi.fn().mockResolvedValue(undefined)
        vi.spyOn(systemJobModule, 'systemJobsSchedule').mockReturnValue({
            upsertJob,
            init: vi.fn(),
            startWorker: vi.fn(),
            removeJob: vi.fn(),
            getJob: vi.fn(),
            close: vi.fn(),
        } as unknown as ReturnType<typeof systemJobModule.systemJobsSchedule>)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('on POST /v1/app-connections — the route the reconnect dialog submits to', async () => {
        const ctx = await createTestContext(app)
        const qadam = await seedQadamMetadata(ctx)

        const response = await ctx.post('/v1/app-connections', connectionBody({
            ctx,
            qadam,
            externalId: 'delivery-mode-upsert',
            metadata: { transport: 'long_polling' },
        }))

        expect(response?.statusCode).toBe(StatusCodes.CREATED)
        expect(deliveryModeJobs(upsertJob)).toHaveLength(1)
        expect(deliveryModeJobs(upsertJob)[0].data).toMatchObject({
            qadamName: qadam.name,
            externalId: 'delivery-mode-upsert',
            after: { transport: 'long_polling' },
            // The acting project, not every project the connection may be shared into.
            projectIds: [ctx.project.id],
        })
    })

    it('on POST /v1/app-connections/:id, with the mode as it was and as it now is', async () => {
        const ctx = await createTestContext(app)
        const qadam = await seedQadamMetadata(ctx)

        const created = await ctx.post('/v1/app-connections', connectionBody({
            ctx,
            qadam,
            externalId: 'delivery-mode-update',
            metadata: { transport: 'long_polling' },
        }))
        expect(created?.statusCode).toBe(StatusCodes.CREATED)
        upsertJob.mockClear()

        const response = await ctx.post(`/v1/app-connections/${created?.json().id}`, {
            displayName: 'Delivery Mode Connection',
            metadata: { transport: 'webhook' },
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(deliveryModeJobs(upsertJob)).toHaveLength(1)
        expect(deliveryModeJobs(upsertJob)[0].data).toMatchObject({
            before: { transport: 'long_polling' },
            after: { transport: 'webhook' },
        })
    })

    // `upsertJob` does nothing when it finds an existing job — it discards the newer data, and
    // retries a failed one with its old payload. A per-connection id would therefore throw away a
    // second change arriving while the first fan-out is still running, which is the silent loss this
    // job exists to prevent. Coalescing is done in process by the fan-out itself, which re-reads
    // live state, so two jobs for one connection converge.
    it('gives every change its own job, rather than one per connection', async () => {
        const ctx = await createTestContext(app)
        const qadam = await seedQadamMetadata(ctx)

        const created = await ctx.post('/v1/app-connections', connectionBody({
            ctx,
            qadam,
            externalId: 'delivery-mode-repeat',
            metadata: { transport: 'long_polling' },
        }))
        await ctx.post(`/v1/app-connections/${created?.json().id}`, {
            displayName: 'Delivery Mode Connection',
            metadata: { transport: 'webhook' },
        })

        const ids = deliveryModeJobs(upsertJob).map((job) => job.jobId)
        expect(ids).toHaveLength(2)
        expect(new Set(ids).size).toBe(2)
    })

    // An edit that does not touch the metadata cannot have changed the mode, and the fan-out costs
    // an engine round trip per flow — it must not run on every rename.
    it('but not on an edit that leaves the metadata alone', async () => {
        const ctx = await createTestContext(app)
        const qadam = await seedQadamMetadata(ctx)

        const created = await ctx.post('/v1/app-connections', connectionBody({
            ctx,
            qadam,
            externalId: 'delivery-mode-rename',
            metadata: { transport: 'long_polling' },
        }))
        expect(created?.statusCode).toBe(StatusCodes.CREATED)
        upsertJob.mockClear()

        const response = await ctx.post(`/v1/app-connections/${created?.json().id}`, {
            displayName: 'Renamed, nothing else',
        })

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(deliveryModeJobs(upsertJob)).toEqual([])
    })
})

/**
 * Only the delivery-mode job: the sign-up and project setup this test performs schedule others, and
 * asserting on the whole queue would pass for the wrong reason.
 */
function deliveryModeJobs(upsertJob: ReturnType<typeof vi.fn>): { data: Record<string, unknown>, jobId: string }[] {
    return upsertJob.mock.calls
        .map(([params]) => params.job)
        .filter((job: { name: string }) => job.name === SystemJobName.APPLY_DELIVERY_MODE_CHANGE)
}

function connectionBody({ ctx, qadam, externalId, metadata }: ConnectionBodyParams): Record<string, unknown> {
    return {
        externalId,
        displayName: 'Delivery Mode Connection',
        qadamName: qadam.name,
        projectId: ctx.project.id,
        type: AppConnectionType.SECRET_TEXT,
        value: {
            type: AppConnectionType.SECRET_TEXT,
            secret_text: 'my-secret',
        },
        qadamVersion: qadam.version,
        metadata,
    }
}

async function seedQadamMetadata(ctx: TestContext): Promise<SeededQadam> {
    const qadam = createMockQadamMetadata({
        platformId: ctx.platform.id,
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
    })
    await db.save('qadam_metadata', qadam)
    qadamMetadataService(mockLog).getOrThrow = vi.fn().mockResolvedValue(qadam)
    return { name: qadam.name, version: qadam.version }
}

type SeededQadam = {
    name: string
    version: string
}

type ConnectionBodyParams = {
    ctx: TestContext
    qadam: SeededQadam
    externalId: string
    metadata: Record<string, unknown>
}
