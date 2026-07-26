import { ExecutionMode } from '@aiqadam/shared'
import { DatabaseType } from './database-type'
import { RedisType } from './redis-type'

const ENV_VAR_NAMES = {
    EXECUTION_MODE: 'AP_EXECUTION_MODE',
    REDIS_TYPE: 'AP_REDIS_TYPE',
    DB_TYPE: 'AP_DB_TYPE',
    QUEUE_MODE: 'AP_QUEUE_MODE',
}

const LEGACY_QADAM_ALIASES: Record<string, string> = {
    AP_DEV_QADAMS: 'AP_DEV_PIECES',
    AP_QADAMS_SYNC_MODE: 'AP_PIECES_SYNC_MODE',
    AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS: 'AP_LOAD_TRANSLATIONS_FOR_DEV_PIECES',
}

for (const [newName, oldName] of Object.entries(LEGACY_QADAM_ALIASES)) {
    if (process.env[newName] === undefined && process.env[oldName] !== undefined) {
        process.env[newName] = process.env[oldName]
        console.warn(`[env-migrations] ${oldName} is deprecated; please rename to ${newName}`)
    }
}

// Every configurable prop in this codebase is read as `AP_<NAME>` (see AppSystemProp.getEnvironment
// and WorkerSystemProp), so the AP_ -> QF_ rename is a generic prefix swap rather than a per-name
// list: any `QF_<NAME>` the operator sets is mirrored onto `AP_<NAME>` (QF_ wins on conflict), which
// is the single value every downstream reader (system-props.ts, worker configs.ts, and any direct
// `process.env.AP_*` access) already looks at. Snapshotting process.env up front avoids iterating
// over the `AP_<NAME>` keys this same loop just wrote.
const qfEnvSnapshot = { ...process.env }
for (const [name, value] of Object.entries(qfEnvSnapshot)) {
    // An empty string is "unset" for our purposes: treating QF_X='' as a real value would let a
    // blank QF_ var (e.g. from `- QF_X=${QF_X}` compose interpolation with nothing exported) silently
    // clobber a valid AP_X, so it must not win precedence over an already-configured legacy value.
    if (!name.startsWith('QF_') || value === undefined || value === '') {
        continue
    }
    process.env['AP_' + name.slice('QF_'.length)] = value
}
for (const [name, value] of Object.entries(qfEnvSnapshot)) {
    const isDeprecatedApName = name.startsWith('AP_') && value !== undefined
    if (!isDeprecatedApName) {
        continue
    }
    const qfName = 'QF_' + name.slice('AP_'.length)
    const qfValue = qfEnvSnapshot[qfName]
    if (qfValue !== undefined && qfValue !== '') {
        continue
    }
    console.warn(`[env-migrations] ${name} is deprecated; please rename to ${qfName}`)
}

export const environmentMigrations = {
    migrate(): Record<string, string | undefined> {
        return {
            ...process.env,
            [ENV_VAR_NAMES.EXECUTION_MODE]: migrateExecutionMode(process.env[ENV_VAR_NAMES.EXECUTION_MODE]),
            [ENV_VAR_NAMES.REDIS_TYPE]: migrateRedisType(process.env[ENV_VAR_NAMES.REDIS_TYPE]),
            [ENV_VAR_NAMES.DB_TYPE]: migrateDbType(process.env[ENV_VAR_NAMES.DB_TYPE]),
        }
    },
}

function migrateRedisType(currentRedisType: string | undefined): string | undefined {
    const queueMode = process.env[ENV_VAR_NAMES.QUEUE_MODE]
    if (queueMode === 'MEMORY') {
        return RedisType.MEMORY
    }
    return currentRedisType
}

function migrateExecutionMode(currentExecutionMode: string | undefined): string | undefined {
    if (currentExecutionMode === 'SANDBOXED') {
        return ExecutionMode.SANDBOX_PROCESS
    }
    return currentExecutionMode
}

function migrateDbType(currentDbType: string | undefined): string | undefined {
    if (currentDbType === 'SQLITE3') {
        return DatabaseType.PGLITE
    }
    return currentDbType
}
