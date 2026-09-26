import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// The CLI-generated diff for this change dropped and re-added the whole `projectId` column (to
// narrow it from unbounded `character varying` to `character varying(21)`, matching
// `ApIdSchema`/`project.id`'s own column type) — that would silently discard every existing row's
// `projectId` value on any deployment that already has translation data. `ALTER COLUMN ... TYPE`
// achieves the same end state without dropping the column or its indices at all. Postgres does not
// require the two sides of a foreign key to share an exact varchar length — this narrowing only
// keeps `translation.projectId` consistent with every other `ApIdSchema`-typed id column; it is not
// a constraint the `ADD CONSTRAINT` below would otherwise refuse.
//
// A deployment that already has translation rows may have orphans (a `projectId` whose project was
// deleted before this migration existed to cascade it) — those would make `ADD CONSTRAINT` fail, so
// they are deleted first. This is the one place in the codebase intentionally allowed to delete
// `translation` rows without going through `translation.service.ts`.
export class AddTranslationProjectForeignKey1791000000000 implements Migration {
    name = 'AddTranslationProjectForeignKey1791000000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DELETE FROM "translation" t WHERE NOT EXISTS (SELECT 1 FROM "project" p WHERE p."id" = t."projectId")')
        await queryRunner.query('ALTER TABLE "translation" ALTER COLUMN "projectId" TYPE character varying(21)')
        await queryRunner.query('ALTER TABLE "translation" ADD CONSTRAINT "fk_translation_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "translation" DROP CONSTRAINT "fk_translation_project_id"')
        await queryRunner.query('ALTER TABLE "translation" ALTER COLUMN "projectId" TYPE character varying')
    }
}
