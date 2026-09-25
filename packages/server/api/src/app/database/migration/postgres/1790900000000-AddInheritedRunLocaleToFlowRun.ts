import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddInheritedRunLocaleToFlowRun1790900000000 implements Migration {
    name = 'AddInheritedRunLocaleToFlowRun1790900000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_run" ADD "inheritedRunLocale" character varying`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "flow_run" DROP COLUMN "inheritedRunLocale"`)
    }
}
