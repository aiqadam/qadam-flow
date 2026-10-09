import { isNil } from '@aiqadam/shared'
import { frameworkCensusPolicy } from './framework-census-policy'
import { PlatformFrameworkCensus } from './framework-census-service'

// Once a release retires a context version, a platform's census walks every flow of the platform.
// `GET /v1/framework-census` answers from this cache, so however often an admin (or a script holding
// an admin token) asks, each API process walks a platform at most once per TTL, and concurrent
// requests share the one walk in flight instead of each starting their own on the shared Postgres.
// The census is a report, not a gate: a few minutes of staleness after a step is updated is fine.
export const FRAMEWORK_CENSUS_CACHE_TTL_MS = 5 * 60 * 1000

export const singleFlightTtlCache = {
    // `maxInFlightMs` bounds how long callers wait on one computation: a walk that hangs (a stuck
    // connection) is replaced by a fresh one after it, instead of answering for its key until the
    // process restarts.
    create<T>({ ttlMs, maxInFlightMs = 2 * ttlMs, now = (): number => Date.now() }: {
        ttlMs: number
        maxInFlightMs?: number
        now?: () => number
    }): SingleFlightTtlCache<T> {
        const entries = new Map<string, CacheEntry<T>>()
        return {
            get({ key, compute }): Promise<T> {
                pruneStale({ entries, time: now(), maxInFlightMs })
                const existing = entries.get(key)
                if (!isNil(existing)) {
                    return existing.value
                }
                const value = compute()
                const entry: CacheEntry<T> = { value, startedAt: now(), expiresAt: null }
                entries.set(key, entry)
                // The TTL starts when the value settles, so a slow walk is not stale the moment it
                // lands. A failure is never cached: the next request tries again.
                value.then(
                    () => {
                        entry.expiresAt = now() + ttlMs
                    },
                    () => {
                        if (entries.get(key) === entry) {
                            entries.delete(key)
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

// Expired entries go on every read, so a platform asked about once does not stay in memory; so do
// computations in flight for longer than `maxInFlightMs`.
function pruneStale<T>({ entries, time, maxInFlightMs }: { entries: Map<string, CacheEntry<T>>, time: number, maxInFlightMs: number }): void {
    for (const [key, entry] of entries) {
        const expired = isNil(entry.expiresAt)
            ? entry.startedAt + maxInFlightMs <= time
            : entry.expiresAt <= time
        if (expired) {
            entries.delete(key)
        }
    }
}

const platformCensuses = singleFlightTtlCache.create<PlatformFrameworkCensus>({ ttlMs: FRAMEWORK_CENSUS_CACHE_TTL_MS })

export type SingleFlightTtlCache<T> = {
    // The cached value for `key` while it is fresh or still being computed; otherwise `compute()`,
    // shared with every caller that asks for `key` until it settles.
    get(params: { key: string, compute: () => Promise<T> }): Promise<T>
    clear(): void
}

type CacheEntry<T> = {
    value: Promise<T>
    startedAt: number
    // `null` while the value is still being computed.
    expiresAt: number | null
}
