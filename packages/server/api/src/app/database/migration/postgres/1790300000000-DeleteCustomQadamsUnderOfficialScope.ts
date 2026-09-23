import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class DeleteCustomQadamsUnderOfficialScope1790300000000 implements Migration {
    name = 'DeleteCustomQadamsUnderOfficialScope1790300000000'
    breaking = true
    release = '2.0.0'

    // One-time cleanup for #503. `qadamMetadataService.create` now refuses a platform-scoped row
    // whose name sits in the `@aiqadam/` scope, because in the default UNSANDBOXED mode such a
    // CUSTOM qadam installs into the workspace every tenant shares and the engine loader used to
    // run it in place of the bundled official qadam of the same name — for every platform on the
    // worker, not just the one that uploaded it. Rows registered before that check existed are the
    // same shadowing, already persisted, so they go the same way.
    //
    // Only rows with a `platformId` match: official qadams are never persisted (they are read off
    // disk by `loadBundledQadams`), so a NULL `platformId` under this scope is not something this
    // repo writes, and is left alone rather than guessed at. The archive `file` row an ARCHIVE
    // qadam points at is left in place too — `bulkDelete` in the service does the same, and the
    // FK runs from `qadam_metadata` to `file`, so the delete is not blocked by it.
    //
    // `LOWER(name)` for the same reason `isOfficialQadamName` lower-cases: npm would refuse an
    // upper-cased name, but an uploaded archive's `package.json` can carry one.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DELETE FROM "qadam_metadata"
            WHERE "platformId" IS NOT NULL
                AND LOWER("name") LIKE '@aiqadam/%'
        `)
    }

    // No-op: the deleted rows cannot be reconstructed from anything left in the database, and a
    // platform that had one registered has to re-upload the qadam under a name outside the
    // official scope — which the service now requires anyway.
    public async down(): Promise<void> {}
}
