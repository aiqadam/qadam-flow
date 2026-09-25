import { apId } from '@aiqadam/shared'
import { databaseConnection, resetDatabaseConnection } from '../../../../src/app/database/database-connection'
import { initializeDatabase } from '../../../../src/app/database'
import { BackfillTranslationPermissionsOnDefaultRoles1790800000000 } from '../../../../src/app/database/migration/postgres/1790800000000-BackfillTranslationPermissionsOnDefaultRoles'

// `ensureDefaultProjectRoles` only INSERTs a role name missing for a platform; it never updates
// one that already exists. This exercises the migration's own `up()` against a `project_role` row
// seeded the way an existing platform's rows look — created before `READ_TRANSLATION` /
// `WRITE_TRANSLATION` existed, so its stored `permissions` array predates them (see the
// migration's own comment for why authorization reads that stored array, not `rolePermissions`).
describe('BackfillTranslationPermissionsOnDefaultRoles1790800000000', () => {
    let ds: ReturnType<typeof databaseConnection>
    const platformId = apId()

    beforeAll(async () => {
        resetDatabaseConnection()
        await initializeDatabase({ runMigrations: true })
        ds = databaseConnection()
    })

    afterAll(async () => {
        await ds.query('DELETE FROM "project_role" WHERE "platformId" = $1', [platformId])
        await ds.destroy()
    })

    async function seedRole(params: { name: string, permissions: string[] }): Promise<string> {
        const id = apId()
        await ds.query(
            'INSERT INTO "project_role" ("id", "name", "permissions", "platformId", "type") VALUES ($1, $2, $3, $4, $5)',
            [id, params.name, params.permissions, platformId, 'DEFAULT'],
        )
        return id
    }

    async function readPermissions(id: string): Promise<string[]> {
        const [row] = await ds.query('SELECT "permissions" FROM "project_role" WHERE "id" = $1', [id])
        return row.permissions
    }

    it('appends READ_TRANSLATION and WRITE_TRANSLATION to a pre-seeded Admin row', async () => {
        const adminId = await seedRole({ name: 'Admin', permissions: ['READ_FLOW', 'WRITE_FLOW'] })

        const queryRunner = ds.createQueryRunner()
        await queryRunner.connect()
        await new BackfillTranslationPermissionsOnDefaultRoles1790800000000().up(queryRunner)
        await queryRunner.release()

        const permissions = await readPermissions(adminId)
        expect(permissions).toEqual(expect.arrayContaining(['READ_FLOW', 'WRITE_FLOW', 'READ_TRANSLATION', 'WRITE_TRANSLATION']))
    })

    it('appends only READ_TRANSLATION (never WRITE_TRANSLATION) to a pre-seeded Viewer row', async () => {
        const viewerId = await seedRole({ name: 'Viewer', permissions: ['READ_FLOW'] })

        const queryRunner = ds.createQueryRunner()
        await queryRunner.connect()
        await new BackfillTranslationPermissionsOnDefaultRoles1790800000000().up(queryRunner)
        await queryRunner.release()

        const permissions = await readPermissions(viewerId)
        expect(permissions).toEqual(expect.arrayContaining(['READ_FLOW', 'READ_TRANSLATION']))
        expect(permissions).not.toContain('WRITE_TRANSLATION')
    })

    it('is idempotent: running it twice never duplicates the permission', async () => {
        const editorId = await seedRole({ name: 'Editor', permissions: ['READ_FLOW'] })

        const runOnce = async (): Promise<void> => {
            const queryRunner = ds.createQueryRunner()
            await queryRunner.connect()
            await new BackfillTranslationPermissionsOnDefaultRoles1790800000000().up(queryRunner)
            await queryRunner.release()
        }
        await runOnce()
        await runOnce()

        const permissions = await readPermissions(editorId)
        expect(permissions.filter((p: string) => p === 'READ_TRANSLATION')).toHaveLength(1)
        expect(permissions.filter((p: string) => p === 'WRITE_TRANSLATION')).toHaveLength(1)
    })

    it('leaves a CUSTOM role untouched', async () => {
        const id = apId()
        await ds.query(
            'INSERT INTO "project_role" ("id", "name", "permissions", "platformId", "type") VALUES ($1, $2, $3, $4, $5)',
            [id, 'My Custom Role', ['READ_FLOW'], platformId, 'CUSTOM'],
        )

        const queryRunner = ds.createQueryRunner()
        await queryRunner.connect()
        await new BackfillTranslationPermissionsOnDefaultRoles1790800000000().up(queryRunner)
        await queryRunner.release()

        const permissions = await readPermissions(id)
        expect(permissions).toEqual(['READ_FLOW'])
    })
})
