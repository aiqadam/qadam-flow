import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddOtpEntity1784713964706 implements Migration {
    name = 'AddOtpEntity1784713964706'
    breaking = false
    release = '1.2.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "otp" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "type" character varying NOT NULL,
                "identityId" character varying(21) NOT NULL,
                "value" character varying NOT NULL,
                "state" character varying NOT NULL,
                CONSTRAINT "PK_32556d9d7b22031d7d0e1fd6723" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_otp_identity_id_type" ON "otp" ("identityId", "type")
        `)
        await queryRunner.query(`
            ALTER TABLE "otp"
            ADD CONSTRAINT "fk_otp_identity_id" FOREIGN KEY ("identityId") REFERENCES "user_identity"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "otp" DROP CONSTRAINT "fk_otp_identity_id"
        `)
        await queryRunner.query(`
            DROP INDEX "idx_otp_identity_id_type"
        `)
        await queryRunner.query(`
            DROP TABLE "otp"
        `)
    }
}
