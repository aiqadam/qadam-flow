import { spawn } from 'node:child_process'
import { copyFile, cp } from 'node:fs/promises'
import { join } from 'path'
import { memoryLock } from '@aiqadam/server-utils'
import { isNil, WebsocketClientEvent } from '@aiqadam/shared'
import chokidar from 'chokidar'
import { FastifyInstance } from 'fastify'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { fileQadamsUtils } from './metadata/utils/file-qadams-utils'
import { invalidateBundledQadamCache } from './metadata/utils/qadam-cache-utils'

const QADAMS_BUILDER_MUTEX_KEY = 'qadams-builder'

async function buildQadams(app: FastifyInstance, qadamsInfo: QadamInfo[]): Promise<void> {
    if (qadamsInfo.length === 0) return

    for (const qadam of qadamsInfo) {
        if (!/^[A-Za-z0-9-]+$/.test(qadam.qadamName)) {
            throw new Error(`Qadam package name contains invalid character: ${qadam.qadamName}`)
        }
    }

    const qadamFilters = qadamsInfo.map(p => `--filter=${p.packageName}`)
    const filterArgs = [
        '--filter=@aiqadam/qadams-framework',
        '--filter=@aiqadam/qadams-common',
        '--filter=@aiqadam/shared',
        ...qadamFilters,
        '--force',
    ]
    app.log.info(`Building ${qadamsInfo.length} qadam(s): ${qadamsInfo.map(p => p.qadamName).join(',')}...`)

    const lock = await memoryLock.acquire(QADAMS_BUILDER_MUTEX_KEY)
    try {
        const startTime = performance.now()
        await spawnAndWait('npx', ['turbo', 'run', 'build', ...filterArgs])
        const buildTime = (performance.now() - startTime) / 1000

        app.log.info(`Build completed in ${buildTime.toFixed(2)} seconds`)

        const utils = fileQadamsUtils(app.log)
        await Promise.all(qadamsInfo.map(async (qadam) => {
            await copyPackageJsonToDist(qadam.qadamDirectory)
            await copyI18nToDist(qadam.qadamDirectory)
            const distPath = await utils.findDistQadamPathByPackageName(qadam.packageName)
            if (distPath) {
                utils.clearQadamModuleCache(distPath)
            }
        }))

        invalidateBundledQadamCache()
        app.io.emit(WebsocketClientEvent.REFRESH_PIECE)
        app.log.info('Changes are ready! Please refresh the frontend to see the new updates.')
    }
    catch (error) {
        app.log.error({ err: error }, 'Failed to run build process...')
    }
    finally {
        await lock.release()
    }
}

export async function startDevQadamWatcher(app: FastifyInstance): Promise<void> {
    const devQadamsConfig = system.get(AppSystemProp.DEV_QADAMS)
    if (isNil(devQadamsConfig) || devQadamsConfig.trim() === '') return

    const qadamNames = [...new Set(devQadamsConfig.split(',').map(n => n.trim()))]
    const utils = fileQadamsUtils(app.log)

    const resolvedInfos = await Promise.all(qadamNames.map(async (qadamName) => {
        const qadamDirectory = await utils.findSourceQadamPathByQadamName(qadamName)
        if (isNil(qadamDirectory)) {
            app.log.warn(`Qadam directory not found for: ${qadamName}`)
            return null
        }
        const packageName = await utils.getPackageNameFromFolderPath(qadamDirectory)
        return { qadamName, qadamDirectory, packageName }
    }))
    const qadamInfos: QadamInfo[] = resolvedInfos.filter((info): info is QadamInfo => info !== null)

    if (qadamInfos.length === 0) return

    const rebuilding = new Set<string>()
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const pendingRebuild = new Set<string>()

    const watchPaths = qadamInfos.flatMap(p => [
        join(p.qadamDirectory, 'src'),
        join(p.qadamDirectory, 'package.json'),
    ])

    const triggerBuild = async (qadamInfo: QadamInfo) => {
        rebuilding.add(qadamInfo.qadamName)
        try {
            await buildQadams(app, [qadamInfo])
        }
        finally {
            rebuilding.delete(qadamInfo.qadamName)
        }
        if (pendingRebuild.has(qadamInfo.qadamName)) {
            pendingRebuild.delete(qadamInfo.qadamName)
            void triggerBuild(qadamInfo)
        }
    }

    const watcher = chokidar.watch(watchPaths, { ignoreInitial: true })

    watcher.on('all', (_event, filePath) => {
        const qadamInfo = qadamInfos.find(p => filePath.startsWith(p.qadamDirectory))
        if (!qadamInfo) return

        clearTimeout(debounceTimers.get(qadamInfo.qadamName))
        debounceTimers.set(qadamInfo.qadamName, setTimeout(() => {
            debounceTimers.delete(qadamInfo.qadamName)
            if (rebuilding.has(qadamInfo.qadamName)) {
                pendingRebuild.add(qadamInfo.qadamName)
                return
            }
            void triggerBuild(qadamInfo)
        }, 300))
    })

    watcher.on('error', (error) => {
        app.log.error({ err: error }, 'File watcher error')
    })

    for (const qadamInfo of qadamInfos) {
        app.log.info(`Watching for changes: ${qadamInfo.qadamName}`)
    }

    const cleanup = async () => {
        await watcher.close()
        for (const timer of debounceTimers.values()) {
            clearTimeout(timer)
        }
    }
    process.once('SIGINT', () => void cleanup())
    process.once('SIGTERM', () => void cleanup())
}

function spawnAndWait(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: process.cwd(),
            stdio: 'inherit',
            shell: false,
        })
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
            }
            else {
                reject(new Error(`Command "${cmd}" exited with code ${code}`))
            }
        })
        child.on('error', reject)
    })
}

async function copyPackageJsonToDist(sourceDir: string): Promise<void> {
    const distDir = join(sourceDir, 'dist')
    await copyFile(join(sourceDir, 'package.json'), join(distDir, 'package.json'))
}

async function copyI18nToDist(sourceDir: string): Promise<void> {
    const i18nSrc = join(sourceDir, 'src', 'i18n')
    const distDir = join(sourceDir, 'dist')
    try {
        await cp(i18nSrc, join(distDir, 'src', 'i18n'), { recursive: true })
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

type QadamInfo = {
    packageName: string
    qadamName: string
    qadamDirectory: string
}
