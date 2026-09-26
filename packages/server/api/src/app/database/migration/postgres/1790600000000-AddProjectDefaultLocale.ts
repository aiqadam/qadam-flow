import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddProjectDefaultLocale1790600000000 implements Migration {
    name = 'AddProjectDefaultLocale1790600000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "project" ADD "defaultLocale" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "project" DROP COLUMN "defaultLocale"
        `)
    }
}
