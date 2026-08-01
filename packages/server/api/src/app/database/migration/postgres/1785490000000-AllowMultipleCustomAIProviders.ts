import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AllowMultipleCustomAIProviders1785490000000 implements Migration {
    name = 'AllowMultipleCustomAIProviders1785490000000'
    breaking = true
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX IF EXISTS "public"."idx_ai_provider_platform_id_provider"')
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_ai_provider_platform_id_provider_not_custom"
            ON "ai_provider" ("platformId", "provider") WHERE "provider" <> 'custom'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX IF EXISTS "public"."idx_ai_provider_platform_id_provider_not_custom"')
        // Fails with 23505 on any install that used the feature this migration enables. That is
        // the intended behaviour: the alternative is deleting a provider row — and its encrypted
        // credentials — to make the rollback fit. `breaking = true` makes rollback-migrations
        // refuse without --force, so the operator sees the refusal before the error.
        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_ai_provider_platform_id_provider"
            ON "ai_provider" ("platformId", "provider")
        `)
    }
}
