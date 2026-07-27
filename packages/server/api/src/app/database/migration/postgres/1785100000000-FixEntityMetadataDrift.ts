import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class FixEntityMetadataDrift1785100000000 implements Migration {
    name = 'FixEntityMetadataDrift1785100000000'
    breaking = false
    release = '1.2.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await assertNoDuplicates(queryRunner)

        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."idx_qadam_metadata_name_platform_id_version"
        `)
        await alterQadamMetadataCollation(queryRunner, '"en_natural"', 'en_natural')
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata"
            ADD CONSTRAINT "UQ_a3878a80553f1f8a286d54dea69" UNIQUE ("archiveId")
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
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_qadam_metadata_name_platform_id_version" ON "qadam_metadata" ("name", "version", "platformId")
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."idx_qadam_metadata_name_platform_id_version"
        `)
        await queryRunner.query(`
            ALTER TABLE "platform"
            ALTER COLUMN "allowedEmbedOrigins"
            SET DEFAULT ARRAY[]::character varying[]
        `)
        await queryRunner.query(`
            ALTER TABLE "platform" DROP CONSTRAINT IF EXISTS "UQ_94d6fd6494f0322c6f0e099141b"
        `)
        await queryRunner.query(`
            ALTER TABLE "qadam_metadata" DROP CONSTRAINT IF EXISTS "UQ_a3878a80553f1f8a286d54dea69"
        `)
        await alterQadamMetadataCollation(queryRunner, 'pg_catalog."default"', 'pg_catalog.default')
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_qadam_metadata_name_platform_id_version" ON "qadam_metadata" ("name", "version", "platformId")
        `)
    }

}

const assertNoDuplicates = async (queryRunner: QueryRunner): Promise<void> => {
    const duplicateOwners: { ownerId: string }[] = await queryRunner.query(`
        SELECT "ownerId" FROM "platform" GROUP BY "ownerId" HAVING count(*) > 1
    `)
    if (duplicateOwners.length > 0) {
        throw new Error(
            'FixEntityMetadataDrift1785100000000: cannot add UNIQUE("ownerId") on "platform" — ' +
            `duplicate ownerId values found: ${duplicateOwners.map((row) => row.ownerId).join(', ')}. ` +
            'Reassign or merge the conflicting platforms so each user owns at most one platform, then retry.',
        )
    }

    const duplicateArchives: { archiveId: string }[] = await queryRunner.query(`
        SELECT "archiveId" FROM "qadam_metadata" WHERE "archiveId" IS NOT NULL GROUP BY "archiveId" HAVING count(*) > 1
    `)
    if (duplicateArchives.length > 0) {
        throw new Error(
            'FixEntityMetadataDrift1785100000000: cannot add UNIQUE("archiveId") on "qadam_metadata" — ' +
            `duplicate archiveId values found: ${duplicateArchives.map((row) => row.archiveId).join(', ')}. ` +
            'Ensure each qadam_metadata row references its own file archive, then retry.',
        )
    }
}

const alterQadamMetadataCollation = async (queryRunner: QueryRunner, targetCollationIdent: string, targetCollationLabel: string): Promise<void> => {
    await queryRunner.query(`
        DO $$ BEGIN
            ALTER TABLE "qadam_metadata" ALTER COLUMN "version" TYPE character varying COLLATE ${targetCollationIdent};
            ALTER TABLE "qadam_metadata" ALTER COLUMN "minimumSupportedRelease" TYPE character varying COLLATE ${targetCollationIdent};
            ALTER TABLE "qadam_metadata" ALTER COLUMN "maximumSupportedRelease" TYPE character varying COLLATE ${targetCollationIdent};
        EXCEPTION
            WHEN feature_not_supported THEN
                RAISE WARNING 'FixEntityMetadataDrift1785100000000: collation ${targetCollationLabel} not supported on this Postgres build (no ICU?) — skipping natural-sort collation on qadam_metadata version columns. check-migrations will report drift on this install until ICU is available.';
            WHEN undefined_object THEN
                RAISE WARNING 'FixEntityMetadataDrift1785100000000: collation ${targetCollationLabel} does not exist — skipping natural-sort collation on qadam_metadata version columns. check-migrations will report drift on this install until the collation is created.';
        END $$
    `)
}
