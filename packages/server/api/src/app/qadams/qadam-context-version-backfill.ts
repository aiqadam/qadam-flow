import {
    ApEnvironment,
    EngineResponseStatus,
    isNil,
    isOfficialQadamName,
    PackageType,
    QadamPackage,
    QadamType,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull, LessThan, Not, Raw } from 'typeorm'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { workerMachineCache } from '../workers/machine/machine-cache'
import { qadamCache } from './metadata/qadam-cache'
import { qadamContextVersion, QadamContextVersion } from './metadata/qadam-context-version'
import { QadamMetadataSchema } from './metadata/qadam-metadata-entity'
import { qadamRepos } from './metadata/qadam-metadata-service'
import { qadamInstallService } from './qadam-install-service'

// Hourly, at an odd minute so it does not pile onto the top-of-the-hour jobs.
const BACKFILL_CRON = '17 * * * *'
// Each row costs a worker install and an engine run; a large backlog drains over several runs.
export const MAX_ROWS_PER_RUN = 10
// A row that failed this often stays NULL (unknown) for good, which the census already treats as
// still needing the old contract. Retries are spaced 6 h, then 12 h after the previous failure.
export const MAX_ATTEMPTS = 3
const RETRY_BASE_HOURS = 6

// Fills `qadam_metadata.contextVersion` for rows registered before the column existed (#802,
// ADR-0002). Not a migration: the version is only known by loading the qadam, which takes a worker
// to fetch the stored archive (or the registry package), install it and run the engine — none of
// which exists while migrations run.
//
// Bounded on purpose (#816 review): a run takes at most MAX_ROWS_PER_RUN rows, stops at the first
// sign that no worker is answering, never loads a row again once it has an answer, and gives a row
// that fails to load MAX_ATTEMPTS tries with a growing gap. It is a repeated job rather than a
// start-up one, so restarting replicas cannot multiply it.
export const qadamContextVersionBackfill = (log: FastifyBaseLogger) => ({
    async schedule(): Promise<void> {
        systemJobHandlers.registerJobHandler(SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL, async () => {
            await backfill(log)
        })
        // Tests insert CUSTOM rows with no worker behind the job queue; a backfill firing in the
        // middle of a run would dispatch engine jobs nobody answers. Tests call `run` directly.
        if (system.get<ApEnvironment>(AppSystemProp.ENVIRONMENT) === ApEnvironment.TESTING) {
            return
        }
        await systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
                data: {},
                jobId: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
            },
            schedule: {
                type: 'repeated',
                cron: BACKFILL_CRON,
            },
        })
    },
    async run(): Promise<BackfillResult> {
        return backfill(log)
    },
})

async function backfill(log: FastifyBaseLogger): Promise<BackfillResult> {
    // Checked first so an instance with no worker connected dispatches nothing and waits out no
    // timeout; the same registry `webhook-backpressure-service.ts` reads.
    const onlineWorkers = await workerMachineCache().find()
    if (onlineWorkers.length === 0) {
        log.info('[qadamContextVersionBackfill] No worker online; skipped')
        return { resolved: 0, failed: 0, stoppedEarly: true }
    }
    const rows = await findRowsToLoad()
    let resolved = 0
    let failed = 0
    let stoppedEarly = false
    for (const row of rows) {
        const outcome = await backfillRow({ row, log })
        if (outcome === RowOutcome.RESOLVED) {
            resolved++
            continue
        }
        failed++
        if (outcome === RowOutcome.WORKER_UNAVAILABLE) {
            stoppedEarly = true
            break
        }
    }
    if (resolved > 0) {
        await qadamCache(log).invalidate()
    }
    const result = { resolved, failed, stoppedEarly }
    if (rows.length > 0) {
        log.info(result, '[qadamContextVersionBackfill] Context versions backfilled')
    }
    return result
}

async function findRowsToLoad(): Promise<QadamMetadataSchema[]> {
    // Reads every platform's rows: a system job, like `ldapReconcileService.reconcileAllPlatforms`,
    // not a request, so `.agents/rules/data-isolation.md`'s per-request filter has no caller to
    // scope by — each row is then loaded and written under its own `platformId`. Official qadams
    // have no row to fill (ADR-0002); the census resolves them through the support table.
    return qadamRepos().find({
        select: {
            id: true,
            name: true,
            version: true,
            platformId: true,
            packageType: true,
            archiveId: true,
            created: true,
            updated: true,
        },
        where: {
            contextVersion: IsNull(),
            qadamType: QadamType.CUSTOM,
            platformId: Not(IsNull()),
            contextVersionAttempts: LessThan(MAX_ATTEMPTS),
            contextVersionLastAttemptAt: Raw((column) => `(${column} IS NULL OR ${column} < now() - make_interval(hours => (:retryBaseHours * power(2, "contextVersionAttempts" - 1))::int))`, {
                retryBaseHours: RETRY_BASE_HOURS,
            }),
        },
        order: {
            created: 'ASC',
        },
        take: MAX_ROWS_PER_RUN,
    })
}

async function backfillRow({ row, log }: { row: QadamMetadataSchema, log: FastifyBaseLogger }): Promise<RowOutcome> {
    const platformId = row.platformId
    if (isNil(platformId)) {
        return RowOutcome.FAILED
    }
    const logContext = { name: row.name, version: row.version, platformId }
    const outcome = await loadRow({ row, platformId, logContext, log })
    if (outcome.kind === RowOutcome.RESOLVED) {
        // `created` / `updated` kept as they were, like `updateUsage`: the catalogue sorts on them,
        // and a backfill is not an edit. The NULL guard keeps a concurrent run from overwriting.
        await qadamRepos().update({ id: row.id, platformId, contextVersion: IsNull() }, {
            contextVersion: outcome.contextVersion,
            created: row.created,
            updated: row.updated,
        })
        return RowOutcome.RESOLVED
    }
    await qadamRepos().update({ id: row.id, platformId, contextVersion: IsNull() }, {
        contextVersionAttempts: () => '"contextVersionAttempts" + 1',
        contextVersionLastAttemptAt: () => 'now()',
        created: row.created,
        updated: row.updated,
    })
    return outcome.kind
}

async function loadRow({ row, platformId, logContext, log }: LoadRowParams): Promise<LoadOutcome> {
    // #503 refuses these names at install and deleted the rows that predated the check. One that
    // still exists is never handed to a worker, which would install it into the shared workspace.
    if (isOfficialQadamName(row.name)) {
        log.warn(logContext, '[qadamContextVersionBackfill] Official-scope name on a custom row; not loaded')
        return { kind: RowOutcome.FAILED }
    }
    const qadamPackage = toQadamPackage({ row, platformId })
    if (isNil(qadamPackage)) {
        log.warn(logContext, '[qadamContextVersionBackfill] Archive qadam has no stored archive; not loaded')
        return { kind: RowOutcome.FAILED }
    }
    const { data: response, error } = await tryCatch(() => qadamInstallService(log).submitExtractQadamMetadata({
        ...qadamPackage,
        platformId,
    }))
    // No answer at all (the watcher's safety timeout, or the queue refused the job): the worker
    // side is the problem, so the run stops here rather than waiting it out once per row. The row
    // still counts an attempt, so one that hangs every worker cannot hold the head of the queue.
    if (error !== null) {
        log.warn({ ...logContext, err: error }, '[qadamContextVersionBackfill] No answer from a worker; run stopped')
        return { kind: RowOutcome.WORKER_UNAVAILABLE }
    }
    if (response.status !== EngineResponseStatus.OK) {
        log.warn({ ...logContext, status: response.status }, '[qadamContextVersionBackfill] Qadam could not be loaded')
        return { kind: RowOutcome.FAILED }
    }
    return { kind: RowOutcome.RESOLVED, contextVersion: qadamContextVersion.fromContextInfo(response.response.contextInfo) }
}

function toQadamPackage({ row, platformId }: { row: QadamMetadataSchema, platformId: string }): QadamPackage | null {
    switch (row.packageType) {
        case PackageType.ARCHIVE:
            if (isNil(row.archiveId)) {
                return null
            }
            return {
                packageType: PackageType.ARCHIVE,
                qadamType: QadamType.CUSTOM,
                qadamName: row.name,
                qadamVersion: row.version,
                archiveId: row.archiveId,
                platformId,
            }
        case PackageType.REGISTRY:
            return {
                packageType: PackageType.REGISTRY,
                qadamType: QadamType.CUSTOM,
                qadamName: row.name,
                qadamVersion: row.version,
                platformId,
            }
    }
}

enum RowOutcome {
    RESOLVED = 'RESOLVED',
    FAILED = 'FAILED',
    WORKER_UNAVAILABLE = 'WORKER_UNAVAILABLE',
}

type LoadOutcome =
    | { kind: RowOutcome.RESOLVED, contextVersion: QadamContextVersion }
    | { kind: RowOutcome.FAILED | RowOutcome.WORKER_UNAVAILABLE }

type BackfillResult = {
    resolved: number
    failed: number
    stoppedEarly: boolean
}

type LoadRowParams = {
    row: QadamMetadataSchema
    platformId: string
    logContext: { name: string, version: string, platformId: string }
    log: FastifyBaseLogger
}
