import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddFlowVersionLocaleSource1790700000000 implements Migration {
    name = 'AddFlowVersionLocaleSource1790700000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_version" ADD "localeSource" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_version" DROP COLUMN "localeSource"
        `)
    }
}
