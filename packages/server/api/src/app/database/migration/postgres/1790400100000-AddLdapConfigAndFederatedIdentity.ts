import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddLdapConfigAndFederatedIdentity1790400100000 implements Migration {
    name = 'AddLdapConfigAndFederatedIdentity1790400100000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "platform_ldap_config" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "config" json NOT NULL,
                "bindPassword" json NOT NULL,
                "caCertificate" json,
                CONSTRAINT "REL_54dc6b26b9d3db002a43c8821e" UNIQUE ("platformId"),
                CONSTRAINT "PK_7d1c37c2486daa133c8573c2aef" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_platform_ldap_config_platform_id" ON "platform_ldap_config" ("platformId")
        `)
        await queryRunner.query(`
            CREATE TABLE "user_federated_identity" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "userId" character varying(21) NOT NULL,
                "provider" character varying NOT NULL,
                "subject" character varying NOT NULL,
                CONSTRAINT "PK_801ed97cbf3034dfad020c67c49" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_user_federated_identity_platform_provider_subject" ON "user_federated_identity" ("platformId", "provider", "subject")
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_user_federated_identity_platform_user_provider" ON "user_federated_identity" ("platformId", "userId", "provider")
        `)
        await queryRunner.query(`
            ALTER TABLE "platform_ldap_config"
            ADD CONSTRAINT "fk_platform_ldap_config_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity"
            ADD CONSTRAINT "fk_user_federated_identity_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user_federated_identity" DROP CONSTRAINT "fk_user_federated_identity_user_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform_ldap_config" DROP CONSTRAINT "fk_platform_ldap_config_platform_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_user_federated_identity_platform_user_provider"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_user_federated_identity_platform_provider_subject"
        `)
        await queryRunner.query(`
            DROP TABLE "user_federated_identity"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_platform_ldap_config_platform_id"
        `)
        await queryRunner.query(`
            DROP TABLE "platform_ldap_config"
        `)
    }
}
