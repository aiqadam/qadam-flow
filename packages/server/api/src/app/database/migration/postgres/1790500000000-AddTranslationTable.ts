import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddTranslationTable1790500000000 implements Migration {
    name = 'AddTranslationTable1790500000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "translation" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying NOT NULL,
                "platformId" character varying NOT NULL,
                "key" character varying NOT NULL,
                "values" jsonb NOT NULL,
                "description" character varying,
                CONSTRAINT "pk_translation" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX "idx_translation_project_id_and_key" ON "translation" ("projectId", "key")')
        await queryRunner.query('CREATE INDEX "idx_translation_project_id" ON "translation" ("projectId")')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE "translation"')
    }
}
