import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddAlertEntity1784724891352 implements Migration {
    name = 'AddAlertEntity1784724891352'
    breaking = false
    release = '1.2.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "alert" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "channel" character varying NOT NULL,
                "receiver" character varying NOT NULL,
                CONSTRAINT "PK_ad91cad659a3536465d564a4b2f" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_alert_project_id" ON "alert" ("projectId")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."idx_alert_project_id"
        `)
        await queryRunner.query(`
            DROP TABLE "alert"
        `)
    }
}
