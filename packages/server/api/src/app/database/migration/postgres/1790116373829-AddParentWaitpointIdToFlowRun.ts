import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddParentWaitpointIdToFlowRun1790116373829 implements Migration {
    name = 'AddParentWaitpointIdToFlowRun1790116373829'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run"
            ADD "parentWaitpointId" character varying(21)
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run" DROP COLUMN "parentWaitpointId"
        `)
    }

}
