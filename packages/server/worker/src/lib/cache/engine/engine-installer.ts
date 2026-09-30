import { PathLike } from 'fs'
import { createHash } from 'node:crypto'
import { copyFile, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileSystemUtils } from '@aiqadam/server-utils'
import { ApEnvironment, isNil } from '@aiqadam/shared'
import { nanoid } from 'nanoid'
import { Logger } from 'pino'
import { workerSettings } from '../../config/worker-settings'
import { cacheState, NO_SAVE_GUARD } from '../cache-state'

const engineExecutablePath = 'dist/packages/engine/main.js'
const ENGINE_INSTALLED = 'ENGINE_INSTALLED'
let engineCacheIdPromise: Promise<string> | null = null

export const engineInstaller = (_log: Logger) => ({
    async install({ path }: InstallParams): Promise<EngineInstallResult> {
        const isDev = workerSettings.getSettings().ENVIRONMENT === ApEnvironment.DEVELOPMENT
        const engineCacheId = await readEngineCacheId()
        const cache = cacheState(path)
        const { cacheHit } = await cache.getOrSetCache({
            key: ENGINE_INSTALLED,
            cacheMiss: (key: string) => {
                const isEngineInstalled = key === engineCacheId
                return !isEngineInstalled || isDev
            },
            installFn: async () => {
                await atomicCopy(engineExecutablePath, `${path}/main.js`)
                await atomicCopy(`${engineExecutablePath}.map`, `${path}/main.js.map`)
                return engineCacheId
            },
            skipSave: NO_SAVE_GUARD,
        })
        return { cacheHit }
    },
})

// The id of the engine bundle this image ships, not a per-process random one (#586): with a random
// id every worker restart was a guaranteed miss, so every freshly started replica copied the engine
// and rewrote `common/cache.json` on its first job, all of them in the same second after a deploy.
// A same-image restart is now a hit, and a different bundle still misses because its bytes differ.
async function readEngineCacheId(): Promise<string> {
    if (isNil(engineCacheIdPromise)) {
        engineCacheIdPromise = hashEngineBundle().catch((error: unknown) => {
            engineCacheIdPromise = null
            throw error
        })
    }
    return engineCacheIdPromise
}

async function hashEngineBundle(): Promise<string> {
    const bundle = await readFile(engineExecutablePath)
    return createHash('sha256').update(bundle).digest('hex')
}

async function atomicCopy(src: PathLike, dest: PathLike): Promise<void> {
    const destDir = dirname(dest.toString())
    const tempPath = join(destDir, `engine.temp.${nanoid()}.js`)
    await fileSystemUtils.threadSafeMkdir(destDir)
    await copyFile(src, tempPath)
    await rename(tempPath, dest)
}

type InstallParams = {
    path: string
}

type EngineInstallResult = {
    cacheHit: boolean
}
