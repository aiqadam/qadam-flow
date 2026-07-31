import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddChatConversation1785486141722 implements Migration {
    name = 'AddChatConversation1785486141722'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "chat_conversation" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "projectId" character varying(21),
                "userId" character varying(21) NOT NULL,
                "title" character varying,
                "modelName" character varying,
                "status" character varying NOT NULL,
                "activeRunId" character varying(21),
                "runHeartbeat" TIMESTAMP WITH TIME ZONE,
                "messages" json NOT NULL DEFAULT '[]',
                "uiMessages" json,
                "summary" character varying,
                "summarizedUpToIndex" integer,
                CONSTRAINT "PK_0c5b7697e69f674eb983b1e83cc" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query(`
            CREATE INDEX "idx_chat_conversation_platform_id_user_id_created" ON "chat_conversation" ("platformId", "userId", "created")
        `)
        await queryRunner.query(`
            ALTER TABLE "chat_conversation"
            ADD CONSTRAINT "fk_chat_conversation_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "chat_conversation"
            ADD CONSTRAINT "fk_chat_conversation_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE
            SET NULL ON UPDATE NO ACTION
        `)
        await queryRunner.query(`
            ALTER TABLE "chat_conversation"
            ADD CONSTRAINT "fk_chat_conversation_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "chat_conversation" DROP CONSTRAINT "fk_chat_conversation_user_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "chat_conversation" DROP CONSTRAINT "fk_chat_conversation_project_id"
        `)
        await queryRunner.query(`
            ALTER TABLE "chat_conversation" DROP CONSTRAINT "fk_chat_conversation_platform_id"
        `)
        await queryRunner.query(`
            DROP INDEX "public"."idx_chat_conversation_platform_id_user_id_created"
        `)
        await queryRunner.query(`
            DROP TABLE "chat_conversation"
        `)
    }
}
