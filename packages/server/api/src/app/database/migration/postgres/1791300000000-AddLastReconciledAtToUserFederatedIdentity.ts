import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddLastReconciledAtToUserFederatedIdentity1791300000000 implements Migration {
    name = 'AddLastReconciledAtToUserFederatedIdentity1791300000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity"
            ADD "lastReconciledAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_user_federated_identity_platform_provider_last_reconciled" ON "user_federated_identity" ("platformId", "provider", "lastReconciledAt")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."idx_user_federated_identity_platform_provider_last_reconciled"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity" DROP COLUMN "lastReconciledAt"
        `)
    }
}
