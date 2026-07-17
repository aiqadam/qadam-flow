import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddProjectMemberTable1784284221314 implements Migration {
    name = 'AddProjectMemberTable1784284221314'
    breaking = false
    release = '1.0.1'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "project_member" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "userId" character varying NOT NULL,
                "projectId" character varying NOT NULL,
                "projectRoleId" character varying NOT NULL,
                "platformId" character varying NOT NULL,
                CONSTRAINT "pk_project_member" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_member_user_project" ON "project_member" ("userId", "projectId")')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE IF EXISTS "project_member"')
    }
}
