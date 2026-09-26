import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddPlatformRoleManagedByToUser1791200000000 implements Migration {
    name = 'AddPlatformRoleManagedByToUser1791200000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD "platformRoleManagedBy" character varying NOT NULL DEFAULT 'MANUAL'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user" DROP COLUMN "platformRoleManagedBy"
        `)
    }
}
