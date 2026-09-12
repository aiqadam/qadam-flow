import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddFlowRunDispatchMode1789026491526 implements Migration {
    name = 'AddFlowRunDispatchMode1789026491526'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run"
            ADD "dispatchMode" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run" DROP COLUMN "dispatchMode"
        `)
    }
}
