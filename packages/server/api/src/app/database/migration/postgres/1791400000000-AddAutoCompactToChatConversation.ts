import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

// #567 replaces the 20-message replay window with compaction: a run now replays everything from
// `summarizedUpToIndex` on. A conversation that was already longer than that window has had its
// older messages dropped, not summarised, so without the backfill its first turn after this release
// would suddenly re-send its whole history. Setting the boundary to where the old window began keeps
// what those conversations send unchanged; the transcript moves it forward to a user turn itself
// (`chatContextUtils.transcriptStart`), so the plain arithmetic here is enough. The CASE, not an
// AND, guards `json_array_length`: SQL does not promise to evaluate a WHERE clause left to right.
export class AddAutoCompactToChatConversation1791400000000 implements Migration {
    name = 'AddAutoCompactToChatConversation1791400000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "chat_conversation"
            ADD "autoCompact" boolean NOT NULL DEFAULT true
        `)
        await queryRunner.query(`
            UPDATE "chat_conversation"
            SET "summarizedUpToIndex" = json_array_length("uiMessages") - 20
            WHERE "summarizedUpToIndex" IS NULL
                AND (CASE WHEN json_typeof("uiMessages") = 'array' THEN json_array_length("uiMessages") ELSE 0 END) > 20
        `)
    }

    // The backfill is not undone: before this release nothing read `summarizedUpToIndex`, so the
    // values it wrote are inert once the column that gives them meaning is gone.
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "chat_conversation" DROP COLUMN "autoCompact"
        `)
    }
}
