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
    AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS: 'AP_LOAD_TRANSLATIONS_FOR_DEV_PIECES',
}

// docker-entrypoint.sh and docker-compose.yml read these bare names in the shell before Node (and
// this whole alias layer) exists, to build the pm2 topology, auto-generate AP_WORKER_TOKEN, and
// interpolate Postgres's own startup config. A QF_ rename can't reach that layer yet (tracked as a
// follow-up), so warning about the AP_ name here would tell every stock Docker install to make a
// change that breaks it. Keep this list in sync with docker-entrypoint.sh / docker-compose.yml, and
// with LEGACY_QADAM_ALIASES's old names below, which already have their own deprecation path.
const SHELL_LAYER_ONLY_NAMES = new Set([
    'CONTAINER_TYPE',
    'PORT',
    'PM2_INSTANCES',
    'JWT_SECRET',
    'WORKER_TOKEN',
    'POSTGRES_DATABASE',
    'POSTGRES_PASSWORD',
    'POSTGRES_USERNAME',
    'QADAMS_SYNC_MODE',
    'WORKER_API_URL',
])

// A QF_ name derived from one of LEGACY_QADAM_ALIASES's *old* piece names (e.g. QF_DEV_PIECES) must
// land directly on the *new* piece name (AP_DEV_QADAMS) - the one actually read downstream - rather
// than on the old AP_ name. Writing it to the old name would both miss the downstream reader and trip
// the legacy loop's own "AP_DEV_PIECES is deprecated" warning for an operator who never set an AP_
// variable at all.
const oldPieceNameToNewPieceName: Record<string, string> = Object.fromEntries(
    Object.entries(LEGACY_QADAM_ALIASES).map(([newName, oldName]) => [oldName, newName]),
)

// Every configurable prop in this codebase is read as `AP_<NAME>` (see AppSystemProp.getEnvironment
// and WorkerSystemProp), so the AP_ -> QF_ rename is a generic prefix swap rather than a per-name
// list: any `QF_<NAME>` the operator sets is mirrored onto `AP_<NAME>` (QF_ wins on conflict), which
// is the single value every downstream reader (system-props.ts, worker configs.ts, and any direct
// `process.env.AP_*` access) already looks at. This runs *before* the legacy piece-rename loop below
// so that e.g. QF_DEV_PIECES lands on AP_DEV_QADAMS (the name actually read downstream) instead of
// being trapped on the already-superseded AP_DEV_PIECES. Snapshotting process.env up front avoids
// iterating over the `AP_<NAME>` keys this same loop just wrote.
const qfEnvSnapshot = { ...process.env }
for (const [name, value] of Object.entries(qfEnvSnapshot)) {
    // An empty string is "unset" for our purposes: treating QF_X='' as a real value would let a
    // blank QF_ var (e.g. from `- QF_X=${QF_X}` compose interpolation with nothing exported) silently
    // clobber a valid AP_X, so it must not win precedence over an already-configured legacy value.
    if (!name.startsWith('QF_') || value === undefined || value === '') {
        continue
    }
    const apName = 'AP_' + name.slice('QF_'.length)
    process.env[oldPieceNameToNewPieceName[apName] ?? apName] = value
}
for (const [name, value] of Object.entries(qfEnvSnapshot)) {
    const isDeprecatedApName = name.startsWith('AP_') && value !== undefined
    if (!isDeprecatedApName) {
        continue
    }
    const bareName = name.slice('AP_'.length)
    if (SHELL_LAYER_ONLY_NAMES.has(bareName) || Object.values(LEGACY_QADAM_ALIASES).includes(name)) {
        continue
    }
    const qfName = 'QF_' + bareName
    const qfValue = qfEnvSnapshot[qfName]
    if (qfValue !== undefined && qfValue !== '') {
        continue
    }
    // This module runs at import time, before any logger exists, so console is the only sink available.
    // eslint-disable-next-line no-console
    console.warn(`[env-migrations] ${name} is deprecated; please rename to ${qfName}`)
}

for (const [newName, oldName] of Object.entries(LEGACY_QADAM_ALIASES)) {
    if (process.env[newName] === undefined && process.env[oldName] !== undefined) {
        process.env[newName] = process.env[oldName]
        // eslint-disable-next-line no-console
        console.warn(`[env-migrations] ${oldName} is deprecated; please rename to ${newName}`)
    }
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
