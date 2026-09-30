import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

export const fileLock = {
    // Cross-process/cross-container mutual exclusion for a resource that lives on a shared
    // filesystem path (e.g. a bind-mounted directory visible to several containers). Unlike
    // an in-memory Mutex, the lock itself lives on disk next to `path`, so it is respected by
    // every process that can see that path — not just the one that acquired it.
    runExclusive: async <T>({ path, fn, createPath = true }: RunExclusiveParams<T>): Promise<T> => {
        const release = await acquire({ path, createPath })
        try {
            return await fn()
        }
        finally {
            await release()
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

async function acquire({ path, createPath }: AcquireParams): Promise<() => Promise<void>> {
    if (createPath) {
        await mkdir(path, { recursive: true })
        return lockfile.lock(path, LOCK_OPTIONS)
    }
    // `path` is only the lock's name here, so nothing is created for it and it is not resolved.
    // Give each lock its own name rather than a second lockfile for an existing path:
    // proper-lockfile tracks held locks by `path`, and two held at once under one path
    // overwrite each other's entry and fail to release.
    await mkdir(dirname(path), { recursive: true })
    return lockfile.lock(path, { ...LOCK_OPTIONS, realpath: false })
}

type RunExclusiveParams<T> = {
    path: string
    fn: () => Promise<T>
    createPath?: boolean
}

type AcquireParams = {
    path: string
    createPath: boolean
}
