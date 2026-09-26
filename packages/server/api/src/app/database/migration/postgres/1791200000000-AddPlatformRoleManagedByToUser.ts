import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// This migration is still branch-local (unreleased on `origin/main`) as of Round 4, so extending
// it with the `platformRoleManualBaseline` column below is safe — no deployed schema has run it
// yet, unlike a migration already on `main`, which must never be edited after the fact. Kept in
// the same file as `platformRoleManagedBy` rather than a fourth migration because both columns
// are part of the same "who owns this user's platformRole" concern on the same table.
export class AddPlatformRoleManagedByToUser1791200000000 implements Migration {
    name = 'AddPlatformRoleManagedByToUser1791200000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD "platformRoleManagedBy" character varying NOT NULL DEFAULT 'MANUAL'
        `)
        await queryRunner.query(`
            ALTER TABLE "user"
            ADD "platformRoleManualBaseline" character varying
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "user" DROP COLUMN "platformRoleManualBaseline"
        `)
        await queryRunner.query(`
            ALTER TABLE "user" DROP COLUMN "platformRoleManagedBy"
        `)
    }
}
