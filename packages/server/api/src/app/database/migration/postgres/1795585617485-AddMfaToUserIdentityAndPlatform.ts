import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddMfaToUserIdentityAndPlatform1795585617485 implements Migration {
    name = 'AddMfaToUserIdentityAndPlatform1795585617485'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD "mfaEnforced" boolean NOT NULL DEFAULT false
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD "mfaEnforcementGracePeriodDays" integer NOT NULL DEFAULT '0'
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD "mfaTrustedIdpProviders" character varying array NOT NULL DEFAULT '{}'
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD "mfaEnforcementEnabledAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaEnabled" boolean NOT NULL DEFAULT false
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaSecret" json
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaPendingSecret" json
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaRecoveryCodes" json
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaEnrolledAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity"
            ADD "mfaLastUsedStep" bigint
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaLastUsedStep"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaEnrolledAt"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaRecoveryCodes"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaPendingSecret"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaSecret"
        `)
        await queryRunner.query(`
            ALTER TABLE "user_identity" DROP COLUMN "mfaEnabled"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP COLUMN "mfaEnforcementEnabledAt"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP COLUMN "mfaTrustedIdpProviders"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP COLUMN "mfaEnforcementGracePeriodDays"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP COLUMN "mfaEnforced"
        `)
    }
}
