import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class BackfillParentWaitpointIdFlowRun1790200000000 implements Migration {
    name = 'BackfillParentWaitpointIdFlowRun1790200000000'
    breaking = false
    release = '2.0.0'

    // One-time backfill for rows created before `flow_run.parentWaitpointId` existed (#521): a
    // non-terminal child that already carries `failParentOnFailure` and a `parentRunId` but no
    // stored `parentWaitpointId` would otherwise fall into `markParentRunAsFailed`'s "predates
    // this check; completing nothing" branch forever, even though its parent is almost certainly
    // still paused on the exact webhook waitpoint the child's own `callFlow` step created.
    //
    // Kept as its own migration, run after the `ADD COLUMN` one: `ALTER TABLE ... ADD COLUMN`
    // takes an `ACCESS EXCLUSIVE` lock on `flow_run` for its (brief) duration, and this `UPDATE`
    // can scan many more rows — running it in a second migration lets the `ALTER`'s lock release
    // before the backfill starts, instead of holding it for the whole scan.
    //
    // Only backfilled when ALL of:
    // - the parent (matched in the child's own `projectId`, never cross-project) has EXACTLY ONE
    //   `PENDING` `WEBHOOK` waitpoint — zero or more than one leaves nothing safe to guess, and
    //   the row is left NULL (the pre-existing "complete nothing" behavior);
    // - that waitpoint was created at or before the child's own `created` timestamp — the
    //   `callFlow` step always creates its waitpoint before it ever sends the request that creates
    //   the child, so a legitimate binding normally satisfies this (the two timestamps come from
    //   the DB and API clocks, so skew can leave a legitimate row NULL — the fail-safe direction);
    //   a waitpoint created afterwards cannot be the one this child's request named;
    // - the child's `dispatchMode` is not `INLINE` — an inline child never goes through the
    //   `failParentOnFailure`/waitpoint path at all (its failure is handled synchronously in the
    //   parent's own engine process), so it must never be backfilled a waitpoint id to complete.
    //
    // This runs once, for rows already in Postgres at migration time; it is not a fail-time
    // fallback and does not run again afterwards.
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            WITH single_pending_webhook_waitpoint AS (
                SELECT "flowRunId", "projectId", MIN(id) AS id, MIN(created) AS created
                FROM waitpoint
                WHERE status = 'PENDING' AND type = 'WEBHOOK'
                GROUP BY "flowRunId", "projectId"
                HAVING COUNT(*) = 1
            )
            UPDATE "flow_run"
            SET "parentWaitpointId" = w.id
            FROM single_pending_webhook_waitpoint w
            WHERE "flow_run".status IN ('QUEUED', 'RUNNING', 'PAUSED')
                AND "flow_run"."failParentOnFailure" = true
                AND "flow_run"."parentRunId" IS NOT NULL
                AND "flow_run"."parentWaitpointId" IS NULL
                AND "flow_run"."dispatchMode" IS DISTINCT FROM 'INLINE'
                AND w."flowRunId" = "flow_run"."parentRunId"
                AND w."projectId" = "flow_run"."projectId"
                AND w.created <= "flow_run".created
        `)
    }

    // No-op: a data backfill can't be reversed by re-nulling every row it touched, since a
    // legitimate write (a real subflow child created after this migration ran) is indistinguishable
    // here from one this backfill set — the column itself only gets dropped by rolling back the
    // earlier `AddParentWaitpointIdToFlowRun` migration.
    public async down(): Promise<void> {}
}
