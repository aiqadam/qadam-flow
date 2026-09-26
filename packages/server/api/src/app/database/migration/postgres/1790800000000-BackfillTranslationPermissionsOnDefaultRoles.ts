import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// `ensureDefaultProjectRoles` (project-service.ts) only INSERTS a `project_role` row for a name
// that is missing for a platform — it never updates one that already exists. `rolePermissions`
// (access-control-list.ts) is the in-memory source of truth for what a DEFAULT role's
// `permissions` array SHOULD contain, but authorization reads the STORED array on the row, not
// that map — so a platform whose Admin/Editor/Viewer rows were seeded before
// `READ_TRANSLATION`/`WRITE_TRANSLATION` existed never gets them, and every translation endpoint
// 403s for every project on that platform, permanently (nothing re-seeds an existing row).
//
// Idempotent by construction: `@>` checks whether the permission is already present before
// appending, so re-running this migration (or running it against a platform whose roles were
// freshly seeded post-fix, which already carry both permissions) is a no-op, never a duplicate.
export class BackfillTranslationPermissionsOnDefaultRoles1790800000000 implements Migration {
    name = 'BackfillTranslationPermissionsOnDefaultRoles1790800000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "project_role"
            SET "permissions" = CASE
                WHEN "permissions" @> ARRAY['READ_TRANSLATION']::varchar[] THEN "permissions"
                ELSE "permissions" || ARRAY['READ_TRANSLATION']::varchar[]
            END
            WHERE "type" = 'DEFAULT' AND "name" IN ('Admin', 'Editor', 'Viewer')
        `)
        await queryRunner.query(`
            UPDATE "project_role"
            SET "permissions" = CASE
                WHEN "permissions" @> ARRAY['WRITE_TRANSLATION']::varchar[] THEN "permissions"
                ELSE "permissions" || ARRAY['WRITE_TRANSLATION']::varchar[]
            END
            WHERE "type" = 'DEFAULT' AND "name" IN ('Admin', 'Editor')
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "project_role"
            SET "permissions" = array_remove(array_remove("permissions", 'READ_TRANSLATION'), 'WRITE_TRANSLATION')
            WHERE "type" = 'DEFAULT' AND "name" IN ('Admin', 'Editor', 'Viewer')
        `)
    }
}
