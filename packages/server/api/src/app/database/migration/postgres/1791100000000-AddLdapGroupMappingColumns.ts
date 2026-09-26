import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddLdapGroupMappingColumns1791100000000 implements Migration {
    name = 'AddLdapGroupMappingColumns1791100000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "project_member"
            ADD "managedBy" character varying NOT NULL DEFAULT 'MANUAL'
        `)
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity"
            ADD "directoryDisabledAt" TIMESTAMP WITH TIME ZONE
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity" DROP COLUMN "directoryDisabledAt"
        `)
        await queryRunner.query(`
            ALTER TABLE "project_member" DROP COLUMN "managedBy"
        `)
    }
}
