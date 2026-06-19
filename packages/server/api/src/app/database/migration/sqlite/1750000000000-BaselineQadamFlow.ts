import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * SQLite is no longer a supported runtime database type — Qadam Flow uses
 * Postgres (`POSTGRES`) and PGLite (`PGLITE`). This baseline is retained only
 * so that the `migration/sqlite/` directory has a non-empty entry point if any
 * tooling (e.g. legacy CLIs or test helpers) discovers it.
 *
 * It intentionally creates no schema; runtime systems will never load it.
 */
export class BaselineQadamFlow1750000000000 implements MigrationInterface {
    name = 'BaselineQadamFlow1750000000000'

    public async up(_queryRunner: QueryRunner): Promise<void> {
        // No-op: SQLite is unsupported at runtime.
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // No-op
    }
}
