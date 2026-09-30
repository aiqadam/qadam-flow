import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'path'
import { fileLock, fileSystemUtils, memoryLock } from '@aiqadam/server-utils'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { Logger } from 'pino'

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
        async getOrSetCache(params: CacheStateParams): Promise<CacheResult> {
            const { key, cacheMiss, crossProcess } = params
            const cache = await readCacheFromMemory(folderPath)
            const value = cache[key] as string | null
            if (!isNil(value) && !cacheMiss(value)) {
                return {
                    cacheHit: true,
                    state: value,
                }
            }
            return memoryLock.runExclusive({
                key: `cache-save-${folderPath}`,
                fn: async () => {
                    if (isNil(crossProcess)) {
                        return readOrInstall({ folderPath, ...params })
                    }
                    // The cache directory is one volume shared by every worker replica (#372), so
                    // the memoryLock only keeps this process's own jobs apart. The fileLock stops two
                    // replicas from building the same entry at once (#586); the one that loses the
                    // race re-reads the disk under the lock and takes the winner's result.
                    const locked = await tryCatch(() => fileLock.runExclusive({
                        path: `${folderPath}${CACHE_STATE_LOCK_SUFFIX}`,
                        createPath: false,
                        log: crossProcess.log,
                        fn: () => readOrInstall({ folderPath, ...params }),
                    }))
                    if (locked.error === null) {
                        return locked.data
                    }
                    if (!fileSystemUtils.hasErrorCode({ error: locked.error, code: 'ELOCKED' })) {
                        throw locked.error
                    }
                    // A legitimate holder can outlast the wait (a cold code build is bun install +
                    // esbuild), and a killed one holds the lock until it goes stale. Failing the job
                    // for that would be worse than building alongside: every crossProcess installFn
                    // publishes by temp file + rename, so a parallel build is wasted work, not a
                    // corrupt entry.
                    crossProcess.log.warn({ folderPath, key }, '[cacheState] Timed out waiting for another replica; installing without the cross-container lock')
                    return readOrInstall({ folderPath, ...params })
                },
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

async function readOrInstall({ folderPath, key, cacheMiss, installFn, skipSave }: ReadOrInstallParams): Promise<CacheResult> {
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
    const freshCache = await cacheState(folderPath).saveCache(key, value)
    cached[folderPath] = freshCache
    return {
        cacheHit: false,
        state: value,
    }
}

// Not write-file-atomic: it names its temp file from pid + an invocation counter, and every
// worker container runs as pid 7, so two replicas' n-th writes shared one temp path on the
// shared volume and one of them failed with `ENOENT ... chown cache.json.<n>` (#586). The fsync
// before the rename is kept from it: without one, a host crash can leave a renamed but empty file.
async function writeFileAtomically({ filePath, content }: WriteFileAtomicallyParams): Promise<void> {
    const tempPath = `${filePath}.${hostname()}.${randomUUID()}.tmp`
    const { error } = await tryCatch(async () => {
        const handle = await open(tempPath, 'w')
        const { error: writeError } = await tryCatch(async () => {
            await handle.writeFile(content, 'utf8')
            await handle.sync()
        })
        await handle.close()
        if (!isNil(writeError)) {
            throw writeError
        }
        await rename(tempPath, filePath)
    })
    if (!isNil(error)) {
        await rm(tempPath, { force: true })
        throw error
    }
}

// An unreadable cache.json is treated as empty: the worst that does is one rebuild, while a
// throw here would fail every job that touches the folder until someone deletes the file.
async function readCacheFromFile(folderPath: string): Promise<CacheMap> {
    const filePath = cachePath(folderPath)
    const fileExists = await fileSystemUtils.fileExists(filePath)
    if (!fileExists) {
        return {}
    }
    const fileContent = await readFile(filePath, 'utf8')
    const { data, error } = tryCatchSync((): unknown => JSON.parse(fileContent))
    if (!isNil(error) || !isCacheMap(data)) {
        return {}
    }
    return data
}

function isCacheMap(value: unknown): value is CacheMap {
    return typeof value === 'object' && !isNil(value) && !Array.isArray(value)
        && Object.values(value).every((entry) => typeof entry === 'string')
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
    // Opt-in, for an installFn that writes shared on-disk state (code builds, the engine copy).
    // A fetch-only installFn has nothing on the volume to protect but its own cache.json write,
    // and taking the lock would serialize e.g. every draft flow-version fetch across replicas.
    crossProcess?: {
        log: Logger
    }
}

type ReadOrInstallParams = CacheStateParams & {
    folderPath: string
}

type WriteFileAtomicallyParams = {
    filePath: string
    content: string
}
