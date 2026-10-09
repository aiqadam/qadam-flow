import { isNil } from '@aiqadam/shared'
import { system } from '../../helper/system/system'
import { frameworkCensusPolicy } from './framework-census-policy'
import { PlatformFrameworkCensus } from './framework-census-service'

// Once a release retires a context version, a platform's census walks every flow of the platform.
// `GET /v1/framework-census` answers from this cache, so however often an admin (or a script holding
// an admin token) asks, each API process walks a platform at most once per TTL, and concurrent
// requests share the one walk in flight instead of each starting their own on the shared Postgres.
// The census is a report, not a gate: a few minutes of staleness after a step is updated is fine.
export const FRAMEWORK_CENSUS_CACHE_TTL_MS = 5 * 60 * 1000

export const singleFlightTtlCache = {
    // `maxInFlightMs` bounds how long anyone waits on one computation. At the bound, every caller
    // sharing it — including those that joined late — is released with an error, the entry is
    // evicted and `onAbandon` is told once; the next caller starts a fresh computation. The
    // abandoned one cannot be cancelled and keeps running until it settles; its late result,
    // success or failure, is ignored.
    create<T>({ ttlMs, maxInFlightMs = 2 * ttlMs, onAbandon }: {
        ttlMs: number
        maxInFlightMs?: number
        onAbandon?: (params: { key: string, maxInFlightMs: number }) => void
    }): SingleFlightTtlCache<T> {
        const entries = new Map<string, CacheEntry<T>>()
        return {
            get({ key, compute }): Promise<T> {
                pruneExpired({ entries, time: Date.now() })
                const existing = entries.get(key)
                if (!isNil(existing)) {
                    return existing.value
                }
                // `compute` runs inside a promise, so a synchronous throw becomes a rejection the race
                // below handles; the deadline is armed only after that, so it always has a handler.
                const computed = Promise.resolve().then(compute)
                const abandoned = new Error(`Abandoned after ${maxInFlightMs} ms in flight`)
                const deadline = rejectAfter({ ms: maxInFlightMs, error: abandoned })
                const value = Promise.race([computed, deadline.promise])
                const entry: CacheEntry<T> = { value, expiresAt: null }
                entries.set(key, entry)
                // The TTL starts when the value settles, so a slow walk is not stale the moment it
                // lands. A failure is never cached: the next request tries again. Both handlers
                // touch only their own entry, so a late settle never displaces a newer one.
                value.then(
                    () => {
                        deadline.cancel()
                        entry.expiresAt = Date.now() + ttlMs
                    },
                    (error: unknown) => {
                        deadline.cancel()
                        if (entries.get(key) === entry) {
                            entries.delete(key)
                        }
                        if (error === abandoned) {
                            onAbandon?.({ key, maxInFlightMs })
                        }
                    },
                )
                return value
            },
            clear(): void {
                entries.clear()
            },
        }
    },
}

export const frameworkCensusCache = {
    // The retired set is part of the key: a census depends on it, so a different set is a
    // different answer (in production it changes only with the release, in tests per case).
    ofPlatform({ platformId, compute }: { platformId: string, compute: () => Promise<PlatformFrameworkCensus> }): Promise<PlatformFrameworkCensus> {
        const key = `${platformId}:${frameworkCensusPolicy.retiredContextVersions().join(',')}`
        return platformCensuses.get({ key, compute })
    },
    clear(): void {
        platformCensuses.clear()
    },
}

// Expired entries go on every read, so a platform asked about once does not stay in memory.
function pruneExpired<T>({ entries, time }: { entries: Map<string, CacheEntry<T>>, time: number }): void {
    for (const [key, entry] of entries) {
        if (!isNil(entry.expiresAt) && entry.expiresAt <= time) {
            entries.delete(key)
        }
    }
}

// The timer is unref'd so a pending deadline never holds the process open, and cancelled as soon as
// the computation settles.
function rejectAfter({ ms, error }: { ms: number, error: Error }): { promise: Promise<never>, cancel: () => void } {
    let timer: NodeJS.Timeout | undefined
    const promise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(error), ms)
        timer.unref()
    })
    return { promise, cancel: () => clearTimeout(timer) }
}

const platformCensuses = singleFlightTtlCache.create<PlatformFrameworkCensus>({
    ttlMs: FRAMEWORK_CENSUS_CACHE_TTL_MS,
    onAbandon: ({ key, maxInFlightMs }) => {
        system.globalLogger().warn({ key, maxInFlightMs }, '[frameworkCensusCache] A platform census was still running at the bound; its waiters were released with an error and the next request starts a new census')
    },
})

export type SingleFlightTtlCache<T> = {
    // The cached value for `key` while it is fresh or still being computed; otherwise `compute()`,
    // shared with every caller that asks for `key` until it settles or reaches `maxInFlightMs`.
    get(params: { key: string, compute: () => Promise<T> }): Promise<T>
    clear(): void
}

type CacheEntry<T> = {
    value: Promise<T>
    // `null` while the value is still being computed.
    expiresAt: number | null
}
