import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'path'
import { fileLock, fileSystemUtils, memoryLock } from '@aiqadam/server-utils'
import { isNil, tryCatch } from '@aiqadam/shared'

type CacheMap = Record<string, string>

const cachePath = (folderPath: string): string =>
    join(folderPath, 'cache.json')
const cached: Record<string, CacheMap | null> = {}
export const NO_SAVE_GUARD = (_: string): boolean => false

// The lock's own name, beside the folder, so it does not share the `<folder>.lock` that qadam
// installs take on the same shared directory (#373): an engine copy has no reason to wait
// behind another replica's `bun install`.
export const CACHE_STATE_LOCK_SUFFIX = '.cache-state'

export const cacheState = (folderPath: string) => {
    return {
        async getOrSetCache({
            cacheMiss,
            key,
            installFn,
            skipSave,
        }: CacheStateParams): Promise<CacheResult> {
            const cache = await readCacheFromMemory(folderPath)
            const value = cache[key] as string | null
            if (!isNil(value) && !cacheMiss(value)) {
                return {
                    cacheHit: true,
                    state: value,
                }
            }
            // The cache directory is one volume shared by every worker replica (#372), so the
            // in-process memoryLock only keeps this process's own jobs apart. The fileLock is what
            // stops two replicas from rebuilding the same entry at once (#586); the replica that
            // loses the race re-reads the disk below and takes the winner's result.
            return memoryLock.runExclusive({
                key: `cache-save-${folderPath}`,
                fn: () => fileLock.runExclusive({
                    path: `${folderPath}${CACHE_STATE_LOCK_SUFFIX}`,
                    createPath: false,
                    fn: async () => {
                        const cacheFromDisk = await readCacheFromFile(folderPath)
                        const valueFromDisk = cacheFromDisk[key]
                        if (!isNil(valueFromDisk) && !cacheMiss(valueFromDisk)) {
                            cached[folderPath] = cacheFromDisk
                            return { cacheHit: true, state: valueFromDisk }
                        }
                        const value = await installFn()
                        if (skipSave(value)) {
                            return {
                                cacheHit: false,
                                state: value,
                            }
                        }
                        const freshCache = await cacheState(folderPath).saveCache(
                            key,
                            value,
                        )
                        cached[folderPath] = freshCache
                        return {
                            cacheHit: false,
                            state: value,
                        }
                    },
                }),
            })
        },
        saveCache: async (key: string, value: string): Promise<CacheMap> => {
            await fileSystemUtils.threadSafeMkdir(folderPath)
            const cacheFilePath = cachePath(folderPath)
            const freshCache = await readCacheFromFile(folderPath)
            freshCache[key] = value
            await writeFileAtomically({ filePath: cacheFilePath, content: JSON.stringify(freshCache) })
            return freshCache
        },
    }
}

// Not write-file-atomic: it names its temp file from pid + an invocation counter, and every
// worker container runs as pid 7, so two replicas' n-th writes shared one temp path on the
// shared volume and one of them failed with `ENOENT ... chown cache.json.<n>` (#586).
async function writeFileAtomically({ filePath, content }: WriteFileAtomicallyParams): Promise<void> {
    const tempPath = `${filePath}.${hostname()}.${randomUUID()}.tmp`
    const { error } = await tryCatch(async () => {
        await writeFile(tempPath, content, 'utf8')
        await rename(tempPath, filePath)
    })
    if (!isNil(error)) {
        await rm(tempPath, { force: true })
        throw error
    }
}

async function readCacheFromFile(folderPath: string): Promise<CacheMap> {
    const filePath = cachePath(folderPath)
    const fileExists = await fileSystemUtils.fileExists(filePath)
    if (!fileExists) {
        return {}
    }
    const fileContent = await readFile(filePath, 'utf8')
    return JSON.parse(fileContent)
}

async function readCacheFromMemory(folderPath: string): Promise<CacheMap> {
    if (isNil(cached[folderPath])) {
        cached[folderPath] = await readCacheFromFile(folderPath)
    }
    return cached[folderPath]
}

type CacheResult = {
    cacheHit: boolean
    state: string | null
}

type CacheStateParams = {
    key: string
    cacheMiss: (value: string) => boolean
    installFn: () => Promise<string>
    skipSave: (value: string) => boolean
}

type WriteFileAtomicallyParams = {
    filePath: string
    content: string
}
