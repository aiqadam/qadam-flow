import { ContextVersion } from '@aiqadam/qadams-framework'
import { FlowStatus, FlowTriggerType, FlowVersionState, PackageType, QadamType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { DataSource } from 'typeorm'
import { databaseConnection, openReadOnlyDatabaseConnection, resetDatabaseConnection } from '../../../../src/app/database/database-connection'
import { frameworkCensusService } from '../../../../src/app/qadams/census/framework-census-service'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

// ADR-0002's `doctor` (#803) runs from a new image against the live database *before* the upgrade.
// The application's connection runs every pending migration inside `initialize()`, so the doctor
// opening that connection would upgrade the database it was only meant to report on.
describe('framework census doctor connection (#803)', () => {
    it('leaves a pending migration pending, refuses writes, and still reads the census', async () => {
        const ctx = await createTestContext(app!)
        await databaseConnection().getRepository('qadam_metadata').insert({
            ...createMockQadamMetadata({
                name: 'doctor-v1-custom',
                version: '1.0.0',
                platformId: ctx.platform.id,
                qadamType: QadamType.CUSTOM,
                packageType: PackageType.REGISTRY,
            }),
            contextVersion: ContextVersion.V1,
        })
        const flow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED, publishedVersionId: null })
        await db.save('flow', flow)
        await db.save('flow_version', createMockFlowVersion({
            flowId: flow.id,
            state: FlowVersionState.DRAFT,
            trigger: {
                type: FlowTriggerType.PIECE,
                name: 'trigger',
                displayName: 'Doctor Trigger',
                valid: true,
                lastUpdatedDate: '2026-01-01T00:00:00.000Z',
                settings: { qadamName: 'doctor-v1-custom', qadamVersion: '1.0.0', triggerName: 'new_item', input: {}, propertySettings: {} },
            },
        }))

        // Make the newest migration pending again, as on a database the new image has not migrated.
        const shared = databaseConnection()
        const [newest] = await shared.query<MigrationRow[]>('SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "timestamp" DESC LIMIT 1')
        await shared.query('DELETE FROM "migrations" WHERE "id" = $1', [newest.id])
        const pendingCount = await countMigrations(shared)

        resetDatabaseConnection()
        const doctor = openReadOnlyDatabaseConnection()
        try {
            await doctor.initialize()

            expect(await countMigrations(doctor)).toBe(pendingCount)
            expect(await doctor.query('SELECT 1 FROM "migrations" WHERE "name" = $1', [newest.name])).toEqual([])
            await expect(doctor.query('DELETE FROM "migrations" WHERE "id" = $1', [newest.id]))
                .rejects.toThrow('read-only transaction')

            // The census reads through the doctor's connection and needs no write anywhere.
            const census = await frameworkCensusService(app!.log).censusOfInstance()
            const platform = census.platforms.find((candidate) => candidate.platformId === ctx.platform.id)
            expect(platform?.steps).toEqual([expect.objectContaining({ pin: 'doctor-v1-custom@1.0.0', contextVersion: ContextVersion.V1, status: 'legacy' })])
        }
        finally {
            if (doctor.isInitialized) {
                await doctor.destroy()
            }
            restoreConnection(shared)
            await shared.query('INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)', [newest.timestamp, newest.name])
        }
        expect(await countMigrations(shared)).toBe(pendingCount + 1)
    })

    it('refuses to replace a connection that already exists', () => {
        expect(() => openReadOnlyDatabaseConnection()).toThrow('A database connection already exists')
    })
})

async function countMigrations(dataSource: DataSource): Promise<number> {
    const [{ count }] = await dataSource.query<{ count: string }[]>('SELECT COUNT(*) AS "count" FROM "migrations"')
    return Number(count)
}

// `openReadOnlyDatabaseConnection` becomes the process's connection, as it must in the doctor. The
// rest of this suite runs on the shared test connection, so the test puts that one back by hand.
function restoreConnection(dataSource: DataSource): void {
    (globalThis as Record<string, unknown>).__AP_DB_CONNECTION__ = dataSource
}

type MigrationRow = {
    id: number
    timestamp: string
    name: string
}
