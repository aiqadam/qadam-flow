import { ErrorCode, formErrors, QadamFlowError, tryCatch } from '@aiqadam/shared'

// The unique index name from migration AddTableKeyDeclaration1789832775045 — matched
// against a Postgres 23505 error's `constraint` to translate it into a
// RECORD_DUPLICATE_KEY QadamFlowError rather than a raw 500. Record has no other unique
// index, so any 23505 raised by a write to this table is this one.
//
// Lives here rather than in record.service.ts because table.service.ts's declareKey needs
// the same mapping, and record.service.ts imports tableService — importing back would be
// circular.
export const KEY_VALUE_UNIQUE_INDEX_NAME = 'idx_record_project_id_table_id_key_value_unique'

export const duplicateKeyError = {
    async map<T>(run: () => Promise<T>): Promise<T> {
        // Read off `result` directly rather than destructured into `{ data, error }`: once
        // destructured, TypeScript loses the correlation between the two fields that makes
        // `Result<T, E>` a discriminated union, and narrowing `error` no longer narrows
        // `data` from `T | null` down to `T`.
        const result = await tryCatch(run)
        if (result.error === null) {
            return result.data
        }
        if (isKeyValueUniqueViolation(result.error)) {
            const message = formErrors.duplicateKeyValue
            throw new QadamFlowError({ code: ErrorCode.RECORD_DUPLICATE_KEY, params: { message } }, 'A record with this key value already exists in this table.')
        }
        throw result.error
    },
}

// A type guard rather than a cast: the driver error is an untyped property TypeORM
// attaches to its own QueryFailedError, and AGENTS.md rules out forcing it with `as`.
function isKeyValueUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('driverError' in error)) {
        return false
    }
    const { driverError } = error
    if (typeof driverError !== 'object' || driverError === null) {
        return false
    }
    const code = 'code' in driverError ? driverError.code : undefined
    const constraint = 'constraint' in driverError ? driverError.constraint : undefined
    return code === '23505' && constraint === KEY_VALUE_UNIQUE_INDEX_NAME
}
