import { readdir, rm } from 'fs/promises'
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

        logger.info({ staleVersions: staleEntries.map((entry) => entry.name) }, 'Deleting stale worker cache versions')

        await Promise.all(staleEntries.map((entry) => rm(path.join(cacheDir, entry.name), { recursive: true, force: true })))
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return
        }
        logger.error({ err: error }, 'Failed to delete stale cache; continuing worker startup')
    }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error
}
