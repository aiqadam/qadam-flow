import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

const OLD_DEFAULT_LOGO = '/logo.svg'
const NEW_DEFAULT_LOGO = '/logo-flow.png'

export class BackfillLogoFlowLockup1789800000000 implements Migration {
    name = 'BackfillLogoFlowLockup1789800000000'
    breaking = false
    release = '2.0.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "platform"
            SET "fullLogoUrl" = $1
            WHERE "fullLogoUrl" = $2
        `, [NEW_DEFAULT_LOGO, OLD_DEFAULT_LOGO])
    }

    // Best-effort only: a platform created after up() runs also has NEW_DEFAULT_LOGO as its
    // legitimate default, and is indistinguishable here from one this migration backfilled.
    // Safe as a same-day rollback; not safe once new platforms have signed up on the new default.
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "platform"
            SET "fullLogoUrl" = $1
            WHERE "fullLogoUrl" = $2
        `, [OLD_DEFAULT_LOGO, NEW_DEFAULT_LOGO])
    }
}
