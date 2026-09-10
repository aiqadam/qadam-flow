import { mkdir } from 'node:fs/promises'
import lockfile from 'proper-lockfile'

export const fileLock = {
    // Cross-process/cross-container mutual exclusion for a resource that lives on a shared
    // filesystem path (e.g. a bind-mounted directory visible to several containers). Unlike
    // an in-memory Mutex, the lock itself lives on disk next to `path`, so it is respected by
    // every process that can see that path — not just the one that acquired it.
    runExclusive: async <T>({ path, fn }: RunExclusiveParams<T>): Promise<T> => {
        await mkdir(path, { recursive: true })
        const release = await lockfile.lock(path, {
            retries: {
                retries: 100,
                factor: 1.2,
                minTimeout: 100,
                maxTimeout: 2000,
            },
            // A container killed mid-install leaves its lock behind forever otherwise —
            // treat a lock older than this as abandoned and let the next installer take it.
            stale: 5 * 60 * 1000,
        })
        try {
            return await fn()
        }
        finally {
            await release()
        }
    },
}

type RunExclusiveParams<T> = {
    path: string
    fn: () => Promise<T>
}
