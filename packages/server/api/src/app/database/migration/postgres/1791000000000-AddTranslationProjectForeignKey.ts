import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// The CLI-generated diff for this change dropped and re-added the whole `projectId` column (to
// narrow it from unbounded `character varying` to `character varying(21)`, matching
// `ApIdSchema`/`project.id`'s own column type) — that would silently discard every existing row's
// `projectId` value on any deployment that already has translation data. `ALTER COLUMN ... TYPE`
// achieves the same end state (and the same length match the FK's target column needs) without
// dropping the column or its indices at all.
export class AddTranslationProjectForeignKey1791000000000 implements Migration {
    name = 'AddTranslationProjectForeignKey1791000000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "translation" ALTER COLUMN "projectId" TYPE character varying(21)')
        await queryRunner.query('ALTER TABLE "translation" ADD CONSTRAINT "fk_translation_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "translation" DROP CONSTRAINT "fk_translation_project_id"')
        await queryRunner.query('ALTER TABLE "translation" ALTER COLUMN "projectId" TYPE character varying')
    }
}
