import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// Both columns are nullable and the index is partial (WHERE "keyValue" IS NOT NULL), so
// this enforces nothing for any table until tableService.declareKey sets
// table.keyFieldIds and backfills record.keyValue (#409) — existing tables are
// unaffected until they opt in. Every existing row has keyValue NULL, so the index is
// built empty and cannot fail on pre-existing duplicates.
//
// CONCURRENTLY, and therefore transaction = false (Postgres forbids it inside one), per
// .agents/skills/db-migration/SKILL.md. The index being empty does not make building it
// free: a plain CREATE UNIQUE INDEX still scans all of "record" to discover that, holding
// a SHARE lock that blocks every write to the table for the duration. "record" is the one
// table in this schema that is routinely millions of rows (MAX_RECORDS_PER_TABLE is 10k
// per table, across every table in every project), and a rolling multi-server upgrade
// keeps the old nodes serving writes while this runs. DROP INDEX IF EXISTS first because
// a CONCURRENTLY build that fails leaves an INVALID index behind, which would make a
// retry of this migration fail on a name that already exists.
export class AddTableKeyDeclaration1789832775045 implements Migration {
    name = 'AddTableKeyDeclaration1789832775045'
    breaking = false
    release = '2.0.0'
    transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "table"
            ADD COLUMN IF NOT EXISTS "keyFieldIds" character varying array
        `)
        await queryRunner.query(`
            ALTER TABLE "record"
            ADD COLUMN IF NOT EXISTS "keyValue" character varying
        `)
        await queryRunner.query(`
            DROP INDEX IF EXISTS "idx_record_project_id_table_id_key_value_unique"
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY "idx_record_project_id_table_id_key_value_unique" ON "record" ("projectId", "tableId", "keyValue")
            WHERE "keyValue" IS NOT NULL
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX CONCURRENTLY IF EXISTS "idx_record_project_id_table_id_key_value_unique"
        `)
        await queryRunner.query(`
            ALTER TABLE "record" DROP COLUMN "keyValue"
        `)
        await queryRunner.query(`
            ALTER TABLE "table" DROP COLUMN "keyFieldIds"
        `)
    }

}
