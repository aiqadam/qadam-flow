import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// Join waitpoints (#374): one WEBHOOK waitpoint answered by N queue-mode children, each through its
// own slot. Additive only — a new table and two nullable columns — so rolling back loses nothing a
// pre-join release could read.
export class AddJoinWaitpointSlots1790400000000 implements Migration {
    name = 'AddJoinWaitpointSlots1790400000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "waitpoint_slot" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "waitpointId" character varying(21) NOT NULL,
                "flowRunId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "slotIndex" integer NOT NULL,
                "status" character varying NOT NULL,
                "payload" text,
                "childRunId" character varying(21),
                CONSTRAINT "PK_600e3c0617803411bff4a6a394c" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_waitpoint_slot_waitpoint_id_slot_index" ON "waitpoint_slot" ("waitpointId", "slotIndex")
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_waitpoint_slot_project_id" ON "waitpoint_slot" ("projectId")
        `)
        await queryRunner.query(`
            ALTER TABLE "flow_run"
            ADD "parentSlotId" character varying(21)
        `)
        await queryRunner.query(`
            ALTER TABLE "waitpoint"
            ADD "join" jsonb
        `)
        await queryRunner.query(`
            ALTER TABLE "waitpoint_slot"
            ADD CONSTRAINT "fk_waitpoint_slot_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "waitpoint_slot"
            ADD CONSTRAINT "fk_waitpoint_slot_waitpoint_id" FOREIGN KEY ("waitpointId") REFERENCES "waitpoint"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "waitpoint_slot" DROP CONSTRAINT "fk_waitpoint_slot_waitpoint_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "waitpoint_slot" DROP CONSTRAINT "fk_waitpoint_slot_project_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "waitpoint" DROP COLUMN "join"
        `)
        await queryRunner.query(`
            ALTER TABLE "flow_run" DROP COLUMN "parentSlotId"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_waitpoint_slot_project_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_waitpoint_slot_waitpoint_id_slot_index"
        `)
        await queryRunner.query(`
            DROP TABLE "waitpoint_slot"
        `)
    }
}
