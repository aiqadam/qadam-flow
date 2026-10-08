import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// ADR-0002 / #802: the context version a custom qadam reports, for the framework-major census
// (#803), plus the backfill's attempt marker. Existing rows start NULL (not measured yet). They are
// not backfilled here: the version is only known by loading the qadam on a worker, which cannot
// happen while migrations run, so `qadamContextVersionBackfill` does it in the background.
export class AddContextVersionToQadamMetadata1791486366657 implements Migration {
    name = 'AddContextVersionToQadamMetadata1791486366657'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD "contextVersion" character varying
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD "contextVersionAttempts" integer NOT NULL DEFAULT '0'
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD "contextVersionLastAttemptAt" TIMESTAMP WITH TIME ZONE
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP COLUMN "contextVersionLastAttemptAt"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP COLUMN "contextVersionAttempts"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP COLUMN "contextVersion"
        `)
    }
}
