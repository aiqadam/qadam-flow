import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// Both columns are nullable and the index is partial (WHERE "keyValue" IS NOT NULL), so
// this enforces nothing for any table until tableService.declareKey sets
// table.keyFieldIds and backfills record.keyValue (#409) — existing tables are
// unaffected until they opt in.
export class AddTableKeyDeclaration1789832775045 implements Migration {
    name = 'AddTableKeyDeclaration1789832775045'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "table"
            ADD "keyFieldIds" character varying array
        `)
        await queryRunner.query(`
            ALTER TABLE "record"
            ADD "keyValue" character varying
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_record_project_id_table_id_key_value_unique" ON "record" ("projectId", "tableId", "keyValue")
            WHERE "keyValue" IS NOT NULL
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."idx_record_project_id_table_id_key_value_unique"
        `)
        await queryRunner.query(`
            ALTER TABLE "record" DROP COLUMN "keyValue"
        `)
        await queryRunner.query(`
            ALTER TABLE "table" DROP COLUMN "keyFieldIds"
        `)
    }

}
