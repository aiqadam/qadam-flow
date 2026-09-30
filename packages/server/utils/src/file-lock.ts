import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import lockfile from 'proper-lockfile'

export const fileLock = {
    // Cross-process/cross-container mutual exclusion for a resource that lives on a shared
    // filesystem path (e.g. a bind-mounted directory visible to several containers). Unlike
    // an in-memory Mutex, the lock itself lives on disk next to `path`, so it is respected by
    // every process that can see that path — not just the one that acquired it.
    runExclusive: async <T>({ path, fn, log, createPath = true }: RunExclusiveParams<T>): Promise<T> => {
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
        const release = await acquire({ path, createPath, onCompromised })
        try {
            return await fn()
        }
        finally {
            await releaseLock({ release, wasCompromised: () => compromised })
        }
    },
}

const LOCK_OPTIONS = {
    retries: {
        retries: 100,
        factor: 1.2,
        minTimeout: 100,
        maxTimeout: 2000,
    },
    // A container killed mid-install leaves its lock behind forever otherwise —
    // treat a lock older than this as abandoned and let the next installer take it.
    stale: 5 * 60 * 1000,
}

async function acquire({ path, createPath, onCompromised }: AcquireParams): Promise<() => Promise<void>> {
    if (createPath) {
        await mkdir(path, { recursive: true })
        return lockfile.lock(path, { ...LOCK_OPTIONS, onCompromised })
    }
    // `path` is only the lock's name here, so nothing is created for it and it is not resolved.
    // Give each lock its own name rather than a second lockfile for an existing path:
    // proper-lockfile tracks held locks by `path`, and two held at once under one path
    // overwrite each other's entry and fail to release.
    await mkdir(dirname(path), { recursive: true })
    return lockfile.lock(path, { ...LOCK_OPTIONS, realpath: false, onCompromised })
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
}

type ReleaseLockParams = {
    release: () => Promise<void>
    wasCompromised: () => boolean
}

type AcquireParams = {
    path: string
    createPath: boolean
    onCompromised: (error: Error) => void
}
