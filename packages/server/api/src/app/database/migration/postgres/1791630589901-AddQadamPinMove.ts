import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// ADR-0003 / #808: the audit record of a step moved off an unavailable qadam version, which the
// revert action works from. Additive: a new table, nothing existing is touched, so rolling back only
// drops the records.
export class AddQadamPinMove1791630589901 implements Migration {
    name = 'AddQadamPinMove1791630589901'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "qadam_pin_move" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "flowId" character varying(21) NOT NULL,
                "flowVersionId" character varying(21) NOT NULL,
                "stepName" character varying NOT NULL,
                "qadamName" character varying NOT NULL,
                "fromVersion" character varying NOT NULL,
                "toVersion" character varying NOT NULL,
                "propsCheck" character varying NOT NULL,
                "cause" character varying NOT NULL,
                "status" character varying NOT NULL,
                "movedBy" character varying,
                "revertedAt" TIMESTAMP WITH TIME ZONE,
                "revertedBy" character varying,
                CONSTRAINT "PK_9ff1be89f69a444b069251b50e8" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_qadam_pin_move_platform_id_created" ON "qadam_pin_move" ("platformId", "created")
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_qadam_pin_move_project_id" ON "qadam_pin_move" ("projectId")
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_qadam_pin_move_flow_id" ON "qadam_pin_move" ("flowId")
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_qadam_pin_move_flow_version_id" ON "qadam_pin_move" ("flowVersionId")
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move"
            ADD CONSTRAINT "fk_qadam_pin_move_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move"
            ADD CONSTRAINT "fk_qadam_pin_move_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move"
            ADD CONSTRAINT "fk_qadam_pin_move_flow_id" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move"
            ADD CONSTRAINT "fk_qadam_pin_move_flow_version_id" FOREIGN KEY ("flowVersionId") REFERENCES "flow_version"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move" DROP CONSTRAINT "fk_qadam_pin_move_flow_version_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move" DROP CONSTRAINT "fk_qadam_pin_move_flow_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move" DROP CONSTRAINT "fk_qadam_pin_move_project_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_pin_move" DROP CONSTRAINT "fk_qadam_pin_move_platform_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_pin_move_flow_version_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_pin_move_flow_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_pin_move_project_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_pin_move_platform_id_created"
        `)
        await queryRunner.query(`
            DROP TABLE "qadam_pin_move"
        `)
    }
}
