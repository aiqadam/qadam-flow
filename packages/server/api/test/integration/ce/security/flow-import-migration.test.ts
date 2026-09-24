import { ErrorCode, FlowOperationType, FlowTriggerType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import * as flowMigrationsModule from '../../../../src/app/flows/flow-version/migrations'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('POST /v1/flows/:id IMPORT_FLOW migration', () => {
    it('rejects the import, and stores nothing, when the migration fails on a schema-valid body', async () => {
        const ctx = await createTestContext(app!)
        const flow = createMockFlow({ projectId: ctx.project.id })
        const version = createMockFlowVersion({ flowId: flow.id, displayName: 'Before import' })
        await db.save('flow', flow)
        await db.save('flow_version', version)
        vi.spyOn(flowMigrationsModule, 'migrateFlowVersionTemplate').mockRejectedValue(new Error('registry unavailable'))

        const response = await ctx.post(`/v1/flows/${flow.id}`, {
            type: FlowOperationType.IMPORT_FLOW,
            request: {
                displayName: 'After import',
                schemaVersion: '1',
                notes: null,
                trigger: {
                    type: FlowTriggerType.EMPTY,
                    name: 'trigger',
                    settings: {},
                    valid: false,
                    displayName: 'Select Trigger',
                    lastUpdatedDate: new Date().toISOString(),
                },
            },
        })

        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(response?.json().code).toBe(ErrorCode.FLOW_MIGRATION_FAILED)
        const stored = await db.findOneByOrFail<{ displayName: string }>('flow_version', { id: version.id })
        expect(stored.displayName).toBe('Before import')
    })

    it('leaves a malformed flow id to the params schema instead of looking it up', async () => {
        const ctx = await createTestContext(app!)
        const migrate = vi.spyOn(flowMigrationsModule, 'migrateFlowVersionTemplate')

        const response = await ctx.post('/v1/flows/a%00b', {
            type: FlowOperationType.IMPORT_FLOW,
            request: { displayName: 'x', schemaVersion: '1', notes: null, trigger: {} },
        })

        expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(migrate).not.toHaveBeenCalled()
    })
})
