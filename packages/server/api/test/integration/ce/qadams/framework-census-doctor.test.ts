import { ContextVersion } from '@aiqadam/qadams-framework'
import { FlowStatus, FlowTriggerType, FlowVersionState, isNil, PackageType, QadamType } from '@aiqadam/shared'
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
        // Every change to shared state happens inside the `try`, and the `finally` undoes only what
        // actually ran, so a failure here cannot leave later serial suites without their connection
        // or their migration row.
        const shared = databaseConnection()
        let removed: MigrationRow | null = null
        let swapped = false
        let doctor: DataSource | null = null
        try {
            const [newest] = await shared.query<MigrationRow[]>('SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "timestamp" DESC LIMIT 1')
            await shared.query('DELETE FROM "migrations" WHERE "id" = $1', [newest.id])
            removed = newest
            const pendingCount = await countMigrations(shared)

            resetDatabaseConnection()
            swapped = true
            doctor = await openReadOnlyDatabaseConnection()

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
            if (doctor?.isInitialized) {
                await doctor.destroy()
            }
            if (swapped) {
                resetDatabaseConnection({ replacement: shared })
            }
            if (!isNil(removed)) {
                await shared.query('INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)', [removed.timestamp, removed.name])
            }
        }
        expect(removed).not.toBeNull()
        expect(await shared.query('SELECT 1 FROM "migrations" WHERE "name" = $1', [removed?.name])).toHaveLength(1)
    })

    // #838: read-only rests on a startup option that a URL's own `?options=` silently overrides (and
    // PgBouncer can drop). The connection must notice and refuse, not report on a writable session.
    it('refuses to open when the session is not read-only, and leaves no connection behind', async () => {
        const shared = databaseConnection()
        const previousUrl = process.env.AP_POSTGRES_URL
        let swapped = false
        try {
            process.env.AP_POSTGRES_URL = postgresUrlWithOptions({ options: '-c default_transaction_read_only=off' })
            resetDatabaseConnection()
            swapped = true

            await expect(openReadOnlyDatabaseConnection()).rejects.toThrow('default_transaction_read_only=off')
            // Failed closed: the refused connection is not left as the process's connection, so a
            // second attempt is refused for the same reason, not as "a connection already exists".
            await expect(openReadOnlyDatabaseConnection()).rejects.toThrow('default_transaction_read_only=off')
        }
        finally {
            if (isNil(previousUrl)) {
                delete process.env.AP_POSTGRES_URL
            }
            else {
                process.env.AP_POSTGRES_URL = previousUrl
            }
            if (swapped) {
                resetDatabaseConnection({ replacement: shared })
            }
        }
    })

    it('refuses to replace a connection that already exists', async () => {
        await expect(openReadOnlyDatabaseConnection()).rejects.toThrow('A database connection already exists')
    })
})

async function countMigrations(dataSource: DataSource): Promise<number> {
    const [{ count }] = await dataSource.query<{ count: string }[]>('SELECT COUNT(*) AS "count" FROM "migrations"')
    return Number(count)
}

// The test database through a URL, as an operator's `POSTGRES_URL` would name it, carrying its own
// `options` startup parameter.
function postgresUrlWithOptions({ options }: { options: string }): string {
    const url = new URL('postgres://localhost')
    url.username = process.env.AP_POSTGRES_USERNAME ?? ''
    url.password = process.env.AP_POSTGRES_PASSWORD ?? ''
    url.hostname = process.env.AP_POSTGRES_HOST ?? ''
    url.port = process.env.AP_POSTGRES_PORT ?? ''
    url.pathname = `/${process.env.AP_POSTGRES_DATABASE ?? ''}`
    url.searchParams.set('options', options)
    return url.toString()
}

type MigrationRow = {
    id: number
    timestamp: string
    name: string
}
