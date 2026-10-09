import { qadamVersionStore, qadamVersionStoreSeed, SeedStatus } from '@aiqadam/server-utils'
import { ApEnvironment, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedLock } from '../../database/redis-connections'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'

// Seeds ADR-0003's versioned qadam store (#805) from what the image ships, in the background at
// start-up. The store is not authoritative yet: no flow resolves a qadam through it until #779, so
// a failure here is logged and changes nothing else — the app starts and runs as before.
//
// Every API replica runs this on the same volume. The lock keeps them from hashing and extracting
// the same tarballs at once; correctness does not depend on it, because each version is written
// by an atomic rename that only one writer wins (`qadamVersionStore`).
export const qadamVersionStoreSeeding = (log: FastifyBaseLogger): { run: () => Promise<void> } => ({
    run: async (): Promise<void> => {
        const { error } = await tryCatch(() => seed({ log }))
        if (error !== null) {
            log.warn({ error: error.message }, '[qadamVersionStore] Seeding the qadam version store failed; nothing reads the store yet, so nothing else is affected')
        }
    },
})

const SEED_LOCK_KEY = 'qadam-version-store-seed'
// Waiting replicas find the work done when they get the lock, so this only bounds a stuck holder.
const SEED_LOCK_TIMEOUT_SECONDS = 15 * 60

async function seed({ log }: { log: FastifyBaseLogger }): Promise<void> {
    const root = system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH)
    const seedDir = system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_SEED_PATH)
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        // A dev tree usually has no writable /var/lib and runs on a laptop's case-insensitive disk;
        // that is expected there, not a problem to warn about.
        const isDev = system.get(AppSystemProp.ENVIRONMENT) === ApEnvironment.DEVELOPMENT
        const message = '[qadamVersionStore] The qadam version store is unavailable; nothing reads it yet, so nothing else is affected'
        if (isDev) {
            log.info({ reason: opened.reason }, message)
        }
        else {
            log.warn({ reason: opened.reason }, message)
        }
        return
    }
    const startedAt = Date.now()
    const report = await distributedLock(log).runExclusive({
        key: SEED_LOCK_KEY,
        timeoutInSeconds: SEED_LOCK_TIMEOUT_SECONDS,
        fn: () => qadamVersionStoreSeed.seedFromImage({ store: opened.store, seedDir, log }),
    })
    const summary = { status: report.status, stored: report.stored, present: report.present, kept: report.kept, failed: report.failed.length, durationMs: Date.now() - startedAt }
    if (report.status === SeedStatus.INVALID_SEED || report.failed.length > 0) {
        log.warn({ ...summary, reason: report.reason }, '[qadamVersionStore] Seeded the qadam version store from the image, with problems')
        return
    }
    log.info(summary, '[qadamVersionStore] Seeded the qadam version store from the image')
}
