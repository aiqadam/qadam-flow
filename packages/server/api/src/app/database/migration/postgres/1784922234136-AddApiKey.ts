import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddApiKey1784922234136 implements Migration {
    name = 'AddApiKey1784922234136'
    breaking = false
    release = '1.2.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "api_key" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "displayName" character varying NOT NULL,
                "platformId" character varying NOT NULL,
                "hashedValue" character varying NOT NULL,
                "truncatedValue" character varying NOT NULL,
                CONSTRAINT "PK_b1bd840641b8acbaad89c3d8d11" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_api_key_platform_id" ON "api_key" ("platformId")
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_api_key_hashed_value" ON "api_key" ("hashedValue")
        `)
        await queryRunner.query(`
            ALTER TABLE "api_key"
            ADD CONSTRAINT "fk_api_key_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "api_key" DROP CONSTRAINT "fk_api_key_platform_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_api_key_hashed_value"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_api_key_platform_id"
        `)
        await queryRunner.query(`
            DROP TABLE "api_key"
        `)
    }
}
