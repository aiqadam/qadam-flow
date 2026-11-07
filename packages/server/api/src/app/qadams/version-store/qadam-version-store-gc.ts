import {
    QadamVersionReadStatus,
    QadamVersionStore,
    qadamVersionStore,
    qadamVersionStoreGcDecision,
    qadamVersionStoreGcLedger,
    qadamVersionStoreSeed,
} from '@aiqadam/server-utils'
import { isNil, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedLock } from '../../database/redis-connections'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { SystemJobName } from '../../helper/system-jobs/common'
import { systemJobHandlers } from '../../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../../helper/system-jobs/system-job'
import { qadamPinUtil } from '../metadata/qadam-pin-util'
import { qadamPinMoveRepo } from '../pin-moves/qadam-pin-move.service'
import { qadamVersionStoreMetrics } from './qadam-version-store-metrics'

const GC_LOCK_KEY = 'qadam-version-store-gc'
// A run walks every flow version on the instance and every stored qadam version; generous, but it
// only has to outlast a stuck run, not a normal one.
const GC_LOCK_TIMEOUT_SECONDS = 30 * 60
const FLOW_VERSION_BATCH_SIZE = 200

// ADR-0003 "GC" and ADR-0004 "Store (#478)": a stored qadam version is deleted only when every one
// of these holds (the decision itself, pure, is `qadamVersionStoreGcDecision`):
//   - it is not pinned by any flow version on the instance, drafts included;
//   - it is not among the versions the currently running image ships;
//   - it is not one of the last `keepLastN` versions a pin move (`qadam_pin_move`, #808/#854) left a
//     step pinned to, which is what a revert reaches back into;
//   - it has been unreferenced (the first three, together) for at least `retentionDays`, tracked by
//     `qadamVersionStoreGcLedger` rather than guessed from `storedAt` — a version pinned for a year
//     and dropped an hour ago must still get the full grace window.
// A version this release cannot read (DAMAGED / UNSUPPORTED / UNREADABLE) is left alone: GC decides
// what is still needed, not what is intact.
export const qadamVersionStoreGc = (log: FastifyBaseLogger) => ({
    async schedule(): Promise<void> {
        systemJobHandlers.registerJobHandler(SystemJobName.QADAM_VERSION_STORE_GC, async () => {
            await runGc(log)
        })
        await systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.QADAM_VERSION_STORE_GC,
                data: {},
                jobId: SystemJobName.QADAM_VERSION_STORE_GC,
            },
            schedule: {
                type: 'repeated',
                cron: system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_GC_CRON),
            },
        })
    },
    async run(): Promise<QadamVersionStoreGcReport> {
        return runGc(log)
    },
})

async function runGc(log: FastifyBaseLogger): Promise<QadamVersionStoreGcReport> {
    const root = system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH)
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        log.warn({ reason: opened.reason }, '[qadamVersionStoreGc] The qadam version store is unavailable; GC is skipped')
        return EMPTY_REPORT
    }
    return distributedLock(log).runExclusive({
        key: GC_LOCK_KEY,
        timeoutInSeconds: GC_LOCK_TIMEOUT_SECONDS,
        fn: () => sweep({ store: opened.store, log }),
    })
}

async function sweep({ store, log }: { store: QadamVersionStore, log: FastifyBaseLogger }): Promise<QadamVersionStoreGcReport> {
    const seedDir = system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_SEED_PATH)
    const retentionDays = system.getNumberOrThrow(AppSystemProp.QADAM_VERSION_STORE_GC_RETENTION_DAYS)
    const keepLastN = system.getNumberOrThrow(AppSystemProp.QADAM_VERSION_STORE_GC_KEEP_LAST_N_VERSIONS)
    const warnBytes = system.getNumberOrThrow(AppSystemProp.QADAM_VERSION_STORE_SIZE_WARN_BYTES)

    const stored = await store.listAllVersions()
    if (stored.length === 0) {
        qadamVersionStoreMetrics.recordSize({ bytes: 0 })
        return EMPTY_REPORT
    }
    // A version this release cannot read as PRESENT (DAMAGED, or UNSUPPORTED because another
    // release or host wrote it in a format only it understands, or UNREADABLE because of a
    // transient I/O error) is left alone: GC decides what is still needed, not what is intact, and
    // the store's own invariant is that only the release or host that wrote an UNSUPPORTED version
    // may ever remove it.
    const readings = await Promise.all(stored.map((coordinates) => store.read({ coordinates })))
    const readable = stored.filter((_coordinates, index) => readings[index]?.status === QadamVersionReadStatus.PRESENT)

    const [imageVersions, pinnedKeys, retainedKeys] = await Promise.all([
        qadamVersionStoreSeed.listImageVersions({ seedDir }),
        collectPinnedKeys({ log }),
        collectRetainedKeys({ keepLastN }),
    ])
    const { unreferenced } = qadamVersionStoreGcDecision.classify({ stored: readable, pinnedKeys, imageVersions, retainedKeys })

    const now = new Date()
    const ledger = qadamVersionStoreGcLedger.open({ dir: store.root, log })
    const reconciled = await ledger.reconcile({ unreferenced, now: now.toISOString() })
    if (!reconciled.ok) {
        log.warn({ reason: reconciled.reason }, '[qadamVersionStoreGc] The GC ledger could not be updated; nothing is collected this run')
    }
    const trackedEntries = reconciled.ok ? reconciled.entries : []
    const eligible = qadamVersionStoreGcDecision.selectEligible({ entries: trackedEntries, now, retentionDays })

    const eligibleReadings = await Promise.all(eligible.map((entry) => store.read({ coordinates: entry })))
    const removed: { qadam: string, bytes: number }[] = []
    for (const [index, entry] of eligible.entries()) {
        const reading = eligibleReadings[index]
        const outcome = await store.remove({ coordinates: entry })
        const qadam = `${entry.name}@${entry.version}`
        if (outcome.status === 'removed') {
            const bytes = reading?.status === QadamVersionReadStatus.PRESENT ? reading.version.integrity.tree.bytes : 0
            removed.push({ qadam, bytes })
            log.info({ qadam, platformId: entry.platformId }, '[qadamVersionStoreGc] Collected an unreferenced qadam version')
        }
        else if (outcome.status === 'refused') {
            log.warn({ qadam, reason: outcome.reason }, '[qadamVersionStoreGc] Could not collect a qadam version')
        }
    }

    const totalBytes = await totalStoreBytes({ store })
    qadamVersionStoreMetrics.recordSize({ bytes: totalBytes })
    if (totalBytes > warnBytes) {
        log.warn({ totalBytes, warnBytes }, '[qadamVersionStoreGc] The qadam version store is above its configured size-warning threshold')
    }

    return {
        scanned: stored.length,
        trackedUnreferenced: trackedEntries.length,
        removed: removed.length,
        removedBytes: removed.reduce((total, entry) => total + entry.bytes, 0),
        totalBytes,
    }
}

async function totalStoreBytes({ store }: { store: QadamVersionStore }): Promise<number> {
    const remaining = await store.listAllVersions()
    const readings = await Promise.all(remaining.map((coordinates) => store.read({ coordinates })))
    return readings.reduce((total, reading) => total + (reading.status === QadamVersionReadStatus.PRESENT ? reading.version.integrity.tree.bytes : 0), 0)
}

// Every (qadamName, qadamVersion) a step or an agent-step tool pins, anywhere on the instance: every
// flow_version row, not only the latest and published ones a request-scoped read would need — a run
// can still be retried against an older LOCKED version, and GC errs toward never deleting a version
// something might still need rather than toward a cheaper query.
async function collectPinnedKeys({ log }: { log: FastifyBaseLogger }): Promise<Set<string>> {
    const keys = new Set<string>()
    let cursor = ''
    for (;;) {
        const { entities, raw } = await flowVersionRepo()
            .createQueryBuilder('fv')
            .innerJoin('flow', 'flow', 'flow.id = fv."flowId"')
            .innerJoin('project', 'project', 'project.id = flow."projectId"')
            .select(['fv.id', 'fv.trigger'])
            .addSelect('project."platformId"', 'platformId')
            .where('project.deleted IS NULL')
            .andWhere('fv.id > :cursor', { cursor })
            .orderBy('fv.id', 'ASC')
            .limit(FLOW_VERSION_BATCH_SIZE)
            .getRawAndEntities()
        if (entities.length === 0) {
            break
        }
        entities.forEach((version, index) => {
            const platformId: string | null = raw[index]?.platformId ?? null
            const { data: pins } = tryCatchSync(() => collectStepPins({ trigger: version.trigger, platformId }))
            if (isNil(pins)) {
                log.warn({ flowVersionId: version.id }, '[qadamVersionStoreGc] A flow version\'s steps could not be read; its pins are not protected by this run')
                return
            }
            pins.forEach((key) => keys.add(key))
        })
        cursor = entities[entities.length - 1].id
    }
    return keys
}

function collectStepPins({ trigger, platformId }: { trigger: Parameters<typeof qadamPinUtil.getQadamSteps>[0]['trigger'], platformId: string | null }): string[] {
    const steps = qadamPinUtil.getQadamSteps({ trigger })
    const tools = qadamPinUtil.getAgentToolPins({ trigger })
    const stepKeys = steps.map((step) => qadamVersionStoreGcDecision.coordinateKey({ name: step.settings.qadamName, version: step.settings.qadamVersion, platformId }))
    const toolKeys = tools.map((tool) => qadamVersionStoreGcDecision.coordinateKey({ name: tool.qadamName, version: tool.qadamVersion, platformId }))
    return [...stepKeys, ...toolKeys]
}

// The last `keepLastN` versions a pin move left a step pinned to (ADR-0004 "Store (#478)"), per
// step identity (`flowId`, `stepName`, `qadamName`): what `POST /v1/qadam-pin-moves/:id/revert`
// reaches back into. Grouped and ranked in SQL rather than in JS, because the table can hold many
// more rows than there are steps, and only the top N per step are ever needed.
async function collectRetainedKeys({ keepLastN }: { keepLastN: number }): Promise<Set<string>> {
    const rows = await qadamPinMoveRepo().manager.query<{ platformId: string, qadamName: string, fromVersion: string }[]>(`
        SELECT "platformId", "qadamName", "fromVersion" FROM (
            SELECT "platformId", "qadamName", "fromVersion",
                   ROW_NUMBER() OVER (PARTITION BY "flowId", "stepName", "qadamName" ORDER BY "created" DESC) AS rn
            FROM "qadam_pin_move"
        ) ranked
        WHERE rn <= $1
    `, [keepLastN])
    return new Set(rows.map((row) => qadamVersionStoreGcDecision.coordinateKey({ name: row.qadamName, version: row.fromVersion, platformId: row.platformId })))
}

const EMPTY_REPORT: QadamVersionStoreGcReport = {
    scanned: 0,
    trackedUnreferenced: 0,
    removed: 0,
    removedBytes: 0,
    totalBytes: 0,
}

export type QadamVersionStoreGcReport = {
    scanned: number
    trackedUnreferenced: number
    removed: number
    removedBytes: number
    totalBytes: number
}
