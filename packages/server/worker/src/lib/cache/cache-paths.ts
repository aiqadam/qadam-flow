import { Dirent } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import path from 'path'
import { logger } from '../config/logger'

export const LATEST_CACHE_VERSION = 'v12'

export const GLOBAL_CACHE_ALL_VERSIONS_PATH = path.resolve('cache')

export function getGlobalCachePathLatestVersion(): string {
    return path.resolve('cache', LATEST_CACHE_VERSION)
}

export function getGlobalCacheCommonPath(): string {
    return path.resolve(getGlobalCachePathLatestVersion(), 'common')
}

export function getGlobalCodeCachePath(): string {
    return path.resolve(getGlobalCachePathLatestVersion(), 'codes')
}

export function getGlobalCacheQadamsPath(): string {
    return path.resolve(getGlobalCachePathLatestVersion(), 'pieces-metadata')
}

export function getGlobalCacheFlowsPath(): string {
    return path.resolve(getGlobalCachePathLatestVersion(), 'flows')
}

export function getEnginePath(): string {
    return path.join(getGlobalCacheCommonPath(), 'main.js')
}

export async function deleteStaleCache(): Promise<void> {
    try {
        const cacheDir = path.resolve(GLOBAL_CACHE_ALL_VERSIONS_PATH)
        const entries = await readdir(cacheDir, { withFileTypes: true })
        const staleEntries = entries.filter((entry) => entry.isDirectory() && entry.name !== LATEST_CACHE_VERSION)

        if (staleEntries.length === 0) {
            return
        }

        const evictable = await filterEvictable({ cacheDir, staleEntries })
        if (evictable.length === 0) {
            return
        }

        logger.info({ staleVersions: evictable }, 'Deleting stale worker cache versions')

        await Promise.all(evictable.map((name) => rm(path.join(cacheDir, name), { recursive: true, force: true })))
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return
        }
        logger.error({ err: error }, 'Failed to delete stale cache; continuing worker startup')
    }
}

// A rolling `docker compose pull && up -d` restart overlaps old- and new-version
// workers for seconds to minutes at most, on the same shared cache volume. A
// version only becomes eligible for eviction once nothing under it has changed
// for this long, so that overlap window closes on its own well before eviction
// runs. Chosen generously (two orders of magnitude above the restart window)
// specifically because directory mtimes are a coarse, write-only signal (see
// isEvictable below) — the margin has to cover for the signal's own blind
// spots, not just the restart itself.
const STALE_CACHE_MIN_IDLE_MS = 6 * 60 * 60 * 1000

// How many levels below the version root to probe for activity. A qadam
// install lands at pieces-metadata/<npm-scope>/<qadam>-<version>-<platformId>
// — two levels down, because the npm-scoped piece name itself contains a "/"
// — so depth 2 (root, its children, and their children) is what's needed to
// see that. codes/ and flows/ already advance one level deep (their leaf
// entries are direct children), so depth 2 covers those too.
const MTIME_PROBE_DEPTH = 2

async function filterEvictable({ cacheDir, staleEntries }: { cacheDir: string, staleEntries: Dirent[] }): Promise<string[]> {
    const decisions = await Promise.all(staleEntries.map(async (entry) => ({
        name: entry.name,
        evictable: await isEvictable(path.join(cacheDir, entry.name)),
    })))
    return decisions.filter((decision) => decision.evictable).map((decision) => decision.name)
}

// A directory's own mtime only advances when an entry is added, removed, or
// renamed *directly inside it* — never for writes deeper in the tree, and
// never for reads at any depth (verified empirically: writing a file two
// levels down left the top-level dir's mtime untouched). Probing root +
// children + grandchildren (MTIME_PROBE_DEPTH) captures real write activity
// throughout the version, including qadam installs (see above). It still
// can't see pure reads, and this volume can't assume atime is enabled, so it
// does not fully close a worker that is only ever reading an already-warm
// cache during the exact restart window — the multi-hour threshold above is
// what covers that gap in practice, not this function.
//
// Fails closed: a stat/readdir error other than ENOENT (EACCES, EPERM, EIO,
// ELOOP, ...) means "couldn't determine whether this is safe to delete", and
// this heuristic's only job is to avoid deleting something in use — so that
// resolves to "not evictable", logged, rather than silently falling through
// to "evictable".
async function isEvictable(versionDir: string): Promise<boolean> {
    const probes = await collectMtimeProbes(versionDir, MTIME_PROBE_DEPTH)

    const unreadable = probes.find((probe): probe is MtimeProbeUnreadable => probe.kind === 'unreadable')
    if (unreadable) {
        logger.warn({ path: unreadable.path, code: unreadable.code }, 'Could not fully read a stale cache version while checking its age; leaving it in place rather than risk deleting something in use')
        return false
    }

    const mtimesMs = probes
        .filter((probe): probe is MtimeProbeValue => probe.kind === 'value')
        .map((probe) => probe.mtimeMs)

    if (mtimesMs.length === 0) {
        // The version root itself is already gone - a sibling replica won the race.
        return true
    }

    return Date.now() - Math.max(...mtimesMs) >= STALE_CACHE_MIN_IDLE_MS
}

async function collectMtimeProbes(targetPath: string, depthRemaining: number): Promise<MtimeProbe[]> {
    const rootProbe = await probeMtime(targetPath)
    if (rootProbe.kind !== 'value' || depthRemaining === 0) {
        return [rootProbe]
    }

    let dirEntries: Dirent[]
    try {
        dirEntries = await readdir(targetPath, { withFileTypes: true })
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return [rootProbe]
        }
        return [rootProbe, { kind: 'unreadable', path: targetPath, code: isErrnoException(error) ? error.code : undefined }]
    }

    const childProbes = await Promise.all(
        dirEntries
            .filter((entry) => entry.isDirectory())
            .map((entry) => collectMtimeProbes(path.join(targetPath, entry.name), depthRemaining - 1)),
    )
    return [rootProbe, ...childProbes.flat()]
}

async function probeMtime(targetPath: string): Promise<MtimeProbe> {
    try {
        const targetStat = await stat(targetPath)
        return { kind: 'value', mtimeMs: targetStat.mtimeMs }
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return { kind: 'gone' }
        }
        return { kind: 'unreadable', path: targetPath, code: isErrnoException(error) ? error.code : undefined }
    }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error
}

type MtimeProbeValue = { kind: 'value', mtimeMs: number }
type MtimeProbeGone = { kind: 'gone' }
type MtimeProbeUnreadable = { kind: 'unreadable', path: string, code: string | undefined }
type MtimeProbe = MtimeProbeValue | MtimeProbeGone | MtimeProbeUnreadable
