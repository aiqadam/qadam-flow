import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class FixEntityMetadataDrift1785100000000 implements Migration {
    name = 'FixEntityMetadataDrift1785100000000'
    breaking = false
    release = '1.1.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP CONSTRAINT "fk_qadam_metadata_file"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_metadata_name_platform_id_version"
        `)
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "qadam_metadata" ALTER COLUMN "version" TYPE character varying COLLATE "en_natural";
                ALTER TABLE "qadam_metadata" ALTER COLUMN "minimumSupportedRelease" TYPE character varying COLLATE "en_natural";
                ALTER TABLE "qadam_metadata" ALTER COLUMN "maximumSupportedRelease" TYPE character varying COLLATE "en_natural";
            EXCEPTION
                WHEN feature_not_supported THEN NULL;
                WHEN undefined_object THEN NULL;
            END $$
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD CONSTRAINT "UQ_a3878a80553f1f8a286d54dea69" UNIQUE ("archiveId")
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP CONSTRAINT "fk_platform_user"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD CONSTRAINT "UQ_94d6fd6494f0322c6f0e099141b" UNIQUE ("ownerId")
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ALTER COLUMN "allowedEmbedOrigins"
            SET DEFAULT '{}'
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_qadam_metadata_name_platform_id_version" ON "qadam_metadata" ("name", "version", "platformId")
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD CONSTRAINT "fk_qadam_metadata_file" FOREIGN KEY ("archiveId") REFERENCES "file"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD CONSTRAINT "fk_platform_user" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "platform" DROP CONSTRAINT "fk_platform_user"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP CONSTRAINT "fk_qadam_metadata_file"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_qadam_metadata_name_platform_id_version"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ALTER COLUMN "allowedEmbedOrigins"
            SET DEFAULT ARRAY[]::character varying[]
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP CONSTRAINT "UQ_94d6fd6494f0322c6f0e099141b"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ADD CONSTRAINT "fk_platform_user" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP CONSTRAINT "UQ_a3878a80553f1f8a286d54dea69"
        `)
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "qadam_metadata" ALTER COLUMN "maximumSupportedRelease" TYPE character varying COLLATE pg_catalog."default";
                ALTER TABLE "qadam_metadata" ALTER COLUMN "minimumSupportedRelease" TYPE character varying COLLATE pg_catalog."default";
                ALTER TABLE "qadam_metadata" ALTER COLUMN "version" TYPE character varying COLLATE pg_catalog."default";
            EXCEPTION
                WHEN feature_not_supported THEN NULL;
                WHEN undefined_object THEN NULL;
            END $$
        `)
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_qadam_metadata_name_platform_id_version" ON "qadam_metadata" ("name", "platformId", "version")
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD CONSTRAINT "fk_qadam_metadata_file" FOREIGN KEY ("archiveId") REFERENCES "file"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
        `)
    }

}
