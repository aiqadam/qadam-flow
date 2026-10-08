import { apDayjs } from '@aiqadam/server-utils'
import {
    ApEnvironment,
    isNil,
    isOfficialQadamName,
    PackageType,
    QadamPackage,
    QadamType,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { IsNull, Not } from 'typeorm'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { qadamCache } from './metadata/qadam-cache'
import { qadamContextVersion, QadamContextVersion } from './metadata/qadam-context-version'
import { QadamMetadataSchema } from './metadata/qadam-metadata-entity'
import { qadamRepos } from './metadata/qadam-metadata-service'
import { qadamInstallService } from './qadam-install-service'

const BACKFILL_DELAY_MINUTES = 2

// Fills `qadam_metadata.contextVersion` for rows registered before the column existed (#802,
// ADR-0002). Not a migration: the version is only known by loading the qadam, which takes a worker
// to fetch the stored archive (or the registry package), install it and run the engine — none of
// which exists while migrations run. A row that cannot be loaded stays NULL (unknown), which the
// census counts as still needing the old contract; the next start-up tries it again.
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
        // Delayed so workers have connected; one job id, so replicas starting together share it.
        await systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
                data: {},
                jobId: SystemJobName.QADAM_CONTEXT_VERSION_BACKFILL,
            },
            schedule: {
                type: 'one-time',
                date: apDayjs().add(BACKFILL_DELAY_MINUTES, 'minute'),
            },
        })
    },
    async run(): Promise<BackfillResult> {
        return backfill(log)
    },
})

async function backfill(log: FastifyBaseLogger): Promise<BackfillResult> {
    // Every platform's rows, by design: a maintenance pass, not a request. Official qadams have no
    // row to fill (ADR-0002) — the census resolves them through the framework support table — so
    // only platform-owned CUSTOM rows are read, and each is loaded under its own platform.
    const rows = await qadamRepos().find({
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
        },
        order: {
            created: 'ASC',
        },
    })
    if (rows.length === 0) {
        return { resolved: 0, unknown: 0 }
    }
    const outcomes: boolean[] = []
    for (const row of rows) {
        outcomes.push(await backfillRow({ row, log }))
    }
    const resolved = outcomes.filter(Boolean).length
    const result = { resolved, unknown: rows.length - resolved }
    if (resolved > 0) {
        await qadamCache(log).invalidate()
    }
    log.info(result, '[qadamContextVersionBackfill] Context versions backfilled')
    return result
}

async function backfillRow({ row, log }: { row: QadamMetadataSchema, log: FastifyBaseLogger }): Promise<boolean> {
    const platformId = row.platformId
    if (isNil(platformId)) {
        return false
    }
    const contextVersion = await readContextVersion({ row, platformId, log })
    if (isNil(contextVersion)) {
        return false
    }
    // `created` / `updated` kept as they were, like `updateUsage`: the catalogue sorts on them, and
    // a backfill is not an edit. The NULL guard keeps a concurrent run from overwriting a value.
    const result = await qadamRepos().update({
        id: row.id,
        platformId,
        contextVersion: IsNull(),
    }, {
        contextVersion,
        created: row.created,
        updated: row.updated,
    })
    return !isNil(result.affected) && result.affected > 0
}

async function readContextVersion({ row, platformId, log }: ReadContextVersionParams): Promise<QadamContextVersion | null> {
    const logContext = { name: row.name, version: row.version, platformId }
    // #503 refuses these names at install and deleted the rows that predated the check. One that
    // still exists is never handed to a worker, which would install it into the shared workspace.
    if (isOfficialQadamName(row.name)) {
        log.warn(logContext, '[qadamContextVersionBackfill] Official-scope name on a custom row; left unknown')
        return null
    }
    const qadamPackage = toQadamPackage({ row, platformId })
    if (isNil(qadamPackage)) {
        log.warn(logContext, '[qadamContextVersionBackfill] Archive qadam has no stored archive; left unknown')
        return null
    }
    const { data: metadata, error } = await tryCatch(() => qadamInstallService(log).extractQadamMetadata({
        ...qadamPackage,
        platformId,
    }))
    if (error !== null) {
        log.warn({ ...logContext, err: error }, '[qadamContextVersionBackfill] Qadam could not be loaded; left unknown')
        return null
    }
    return qadamContextVersion.fromContextInfo(metadata.contextInfo)
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

type BackfillResult = {
    resolved: number
    unknown: number
}

type ReadContextVersionParams = {
    row: QadamMetadataSchema
    platformId: string
    log: FastifyBaseLogger
}
