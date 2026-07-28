import { Dirent } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import path from 'path'
import { isNil } from '@aiqadam/shared'
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
// getIdleTimeMs below) — the margin has to cover for the signal's own blind
// spots, not just the restart itself.
const STALE_CACHE_MIN_IDLE_MS = 6 * 60 * 60 * 1000

async function filterEvictable({ cacheDir, staleEntries }: { cacheDir: string, staleEntries: Dirent[] }): Promise<string[]> {
    const decisions = await Promise.all(staleEntries.map(async (entry) => {
        const idleForMs = await getIdleTimeMs(path.join(cacheDir, entry.name))
        return { name: entry.name, evictable: idleForMs === null || idleForMs >= STALE_CACHE_MIN_IDLE_MS }
    }))
    return decisions.filter((decision) => decision.evictable).map((decision) => decision.name)
}

// A directory's own mtime only advances when an entry is added, removed, or
// renamed *directly inside it* — never for writes deeper in the tree, and never
// for reads at any depth (verified empirically: writing a file two levels down
// left the top-level dir's mtime untouched). Each cached version's top-level
// directory (cache/<version>/) only ever gets direct children once, when
// pieces-metadata/common/codes/flows are first created during provisioning —
// every subsequent qadam install or code/flow cache write lands one level
// deeper, inside those four directories, not as a new direct child of the
// version root. So the version directory's own mtime freezes at first-use and
// checking only that would make every version look idle from the moment it's
// created, defeating the grace period entirely. Taking the max mtime across
// the version root *and* its immediate children captures that install-time
// activity instead. It still can't see pure reads (mtime never reflects
// those, and this volume can't assume atime is enabled), so it does not fully
// close a worker that is only ever reading a fully warm cache during the exact
// restart window — the multi-hour threshold above is what covers that gap in
// practice, not this function.
async function getIdleTimeMs(versionDir: string): Promise<number | null> {
    const rootStat = await stat(versionDir).catch(() => null)
    if (isNil(rootStat)) {
        return null
    }
    const children = await readdir(versionDir, { withFileTypes: true }).catch(() => [])
    const childStats = await Promise.all(
        children.filter((child) => child.isDirectory()).map((child) => stat(path.join(versionDir, child.name)).catch(() => null)),
    )
    const mtimesMs = [rootStat.mtimeMs, ...childStats.filter((childStat) => !isNil(childStat)).map((childStat) => childStat.mtimeMs)]
    return Date.now() - Math.max(...mtimesMs)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error
}
