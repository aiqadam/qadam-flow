import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddStoreEntryExpiresAt1789204010898 implements Migration {
    name = 'AddStoreEntryExpiresAt1789204010898'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "store-entry"
            ADD "expiresAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_store_entry_expires_at" ON "store-entry" ("expiresAt")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX "public"."idx_store_entry_expires_at"
        `)
        await queryRunner.query(`
            ALTER TABLE "store-entry" DROP COLUMN "expiresAt"
        `)
    }

}
