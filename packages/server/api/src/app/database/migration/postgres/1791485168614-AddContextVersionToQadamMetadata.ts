import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// ADR-0002 / #802: the context version a custom qadam reports, for the framework-major census
// (#803). Existing rows start NULL, which means unknown. They are not backfilled here: the version
// is only known by loading the qadam on a worker, which cannot happen while migrations run, so
// `qadamContextVersionBackfill` does it after start-up and leaves a row it cannot load unknown.
export class AddContextVersionToQadamMetadata1791485168614 implements Migration {
    name = 'AddContextVersionToQadamMetadata1791485168614'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD "contextVersion" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP COLUMN "contextVersion"
        `)
    }
}
