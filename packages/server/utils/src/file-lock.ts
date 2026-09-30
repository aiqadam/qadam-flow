import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import lockfile from 'proper-lockfile'
import { fileSystemUtils } from './file-system-utils'

export const fileLock = {
    // Cross-process/cross-container mutual exclusion for a resource that lives on a shared
    // filesystem path (e.g. a bind-mounted directory visible to several containers). Unlike
    // an in-memory Mutex, the lock itself lives on disk next to `path`, so it is respected by
    // every process that can see that path — not just the one that acquired it.
    runExclusive: async <T>({ path, fn, log, createPath = true, staleMs = DEFAULT_STALE_MS }: RunExclusiveParams<T>): Promise<T> => {
        let compromised = false
        // proper-lockfile's default throws from its mtime-refresh timer, i.e. as an uncaught
        // exception that takes the whole worker down with every job it is running. Throwing
        // cannot stop `fn` either, which is already past the point the lock protected. So the
        // compromise is logged and `fn` runs to completion: every writer under these locks
        // publishes by temp file + rename, so a second holder can lose work but not corrupt it.
        const onCompromised = (error: Error): void => {
            compromised = true
            log.error({ path, error: error.message }, '[fileLock] Lock was compromised while held; the protected work is no longer exclusive')
        }
        const acquired = await tryCatch(() => acquire({ path, createPath, staleMs, onCompromised }))
        if (acquired.error !== null) {
            throw fileSystemUtils.hasErrorCode({ error: acquired.error, code: 'ELOCKED' }) ? new FileLockTimeoutError({ path }) : acquired.error
        }
        const result = await tryCatch(() => fn())
        const released = await tryCatch(() => releaseLock({ release: acquired.data, wasCompromised: () => compromised }))
        if (result.error !== null) {
            // The work's own failure is what the caller has to act on; a lock left behind goes
            // stale on its own.
            if (released.error !== null) {
                log.error({ path, error: released.error.message }, '[fileLock] Could not release the lock after the protected work failed')
            }
            throw result.error
        }
        if (released.error !== null) {
            throw released.error
        }
        return result.data
    },
    // True only when the lock itself could not be taken in time, never for an error `fn` threw:
    // a caller that falls back on a timeout must not run `fn` a second time because `fn` failed.
    isAcquireTimeout: (error: unknown): boolean => error instanceof FileLockTimeoutError,
}

// A container killed mid-install leaves its lock behind forever otherwise —
// treat a lock older than this as abandoned and let the next installer take it.
const DEFAULT_STALE_MS = 5 * 60 * 1000

// Waits up to ~177 s in total (100 retries, back-off up to 2 s).
const RETRIES = {
    retries: 100,
    factor: 1.2,
    minTimeout: 100,
    maxTimeout: 2000,
}

class FileLockTimeoutError extends Error {
    constructor({ path }: { path: string }) {
        super(`Timed out waiting for the file lock on ${path}`)
        this.name = 'FileLockTimeoutError'
    }
}

async function acquire({ path, createPath, staleMs, onCompromised }: AcquireParams): Promise<() => Promise<void>> {
    // proper-lockfile refreshes a held lock's mtime every stale/2, so a live holder is never
    // mistaken for a dead one however long it holds the lock.
    const options = { retries: RETRIES, stale: staleMs, onCompromised }
    if (createPath) {
        await mkdir(path, { recursive: true })
        return lockfile.lock(path, options)
    }
    // `path` is only the lock's name here, so nothing is created for it and it is not resolved.
    // Give each lock its own name rather than a second lockfile for an existing path:
    // proper-lockfile tracks held locks by `path`, and two held at once under one path
    // overwrite each other's entry and fail to release.
    await mkdir(dirname(path), { recursive: true })
    return lockfile.lock(path, { ...options, realpath: false })
}

async function releaseLock({ release, wasCompromised }: ReleaseLockParams): Promise<void> {
    const { error } = await tryCatch(() => release())
    // A compromised lock is already marked released, so releasing it again always fails.
    if (!isNil(error) && !wasCompromised()) {
        throw error
    }
}

type FileLockLogger = {
    error: (obj: Record<string, unknown>, msg: string) => void
}

type RunExclusiveParams<T> = {
    path: string
    fn: () => Promise<T>
    log: FileLockLogger
    createPath?: boolean
    // How long a lock whose holder stopped refreshing it is honoured before a waiter takes it
    // over. Below the ~177 s wait, a waiter reclaims a killed holder's lock instead of timing out.
    staleMs?: number
}

type ReleaseLockParams = {
    release: () => Promise<void>
    wasCompromised: () => boolean
}

type AcquireParams = {
    path: string
    createPath: boolean
    staleMs: number
    onCompromised: (error: Error) => void
}
