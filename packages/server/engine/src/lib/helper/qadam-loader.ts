import fs from 'fs/promises'
import path from 'path'
import { Action, Qadam, QadamPropertyMap, Trigger } from '@aiqadam/qadams-framework'
import { EngineGenericError, ErrorCode, extractQadamFromModule, getPackageAliasForQadam, getQadamNameFromAlias, isNil, QadamFlowError, trimVersionFromAlias } from '@aiqadam/shared'
import { z } from 'zod'
import { utils } from '../utils'

// Bundled qadams are baked into the image, so a resolved path cannot change while the
// process lives. Both caches hold the in-flight promise so concurrent steps share one walk.
const qadamPathCache = new Map<string, Promise<string>>()
let distIndexCache: Promise<Map<string, DistPackageEntry>> | null = null
// Exact-version aliases only (`name-1.2.3`, plus a prerelease/build suffix). A dev qadam is
// resolved by bare name and has no version to compare.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+].*)?$/
const distPackageJsonSchema = z.object({ name: z.string(), version: z.string().optional() })

export const qadamLoader = {
    loadQadamOrThrow: async (
        { qadamName, qadamVersion, devQadams }: LoadPieceParams,
    ): Promise<Qadam> => {
        const { data: qadam, error: qadamError } = await utils.tryCatchAndThrowOnEngineError(async () => {
            const packageName = qadamLoader.getPackageAlias({
                qadamName,
                qadamVersion,
                devQadams,
            })
            const qadamPath = await qadamLoader.getQadamPath({ packageName, devQadams })
            const module = await import(qadamPath)

            const qadam = extractQadamFromModule<Qadam>({
                module,
                qadamName,
                qadamVersion,
            })

            if (isNil(qadam)) {
                throw new EngineGenericError('QadamNotFoundError', `Qadam not found for qadamName: ${qadamName}, qadamVersion: ${qadamVersion}`)
            }
            return qadam
        })
        if (qadamError) {
            throw qadamError
        }
        return qadam
    },

    getQadamAndTriggerOrThrow: async (params: GetQadamAndTriggerParams): Promise<{ qadam: Qadam, qadamTrigger: Trigger }> => {
        const { qadamName, qadamVersion, triggerName, devQadams } = params
        const qadam = await qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams })
        const trigger = qadam.getTrigger(triggerName)

        if (trigger === undefined) {
            throw new EngineGenericError('TriggerNotFoundError', `Trigger not found, qadamName=${qadamName}, triggerName=${triggerName}`)
        }

        return {
            qadam,
            qadamTrigger: trigger,
        }
    },

    getQadamAndActionOrThrow: async (params: GetQadamAndActionParams): Promise<{ qadam: Qadam, qadamAction: Action }> => {
        const { qadamName, qadamVersion, actionName, devQadams } = params

        const qadam = await qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams })
        const qadamAction = qadam.getAction(actionName)

        if (isNil(qadamAction)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'step',
                    entityId: actionName,
                    message: `Action not found for qadam ${qadamName}@${qadamVersion}`,
                    extra: { qadamName, qadamVersion },
                },
            })
        }

        return {
            qadam,
            qadamAction,
        }
    },

    getPropOrThrow: async ({ qadamName, qadamVersion, actionOrTriggerName, propertyName, devQadams }: GetPropParams) => {
        const qadam = await qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams })

        const actionOrTrigger = qadam.getAction(actionOrTriggerName) ?? qadam.getTrigger(actionOrTriggerName)

        if (isNil(actionOrTrigger)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'step',
                    entityId: actionOrTriggerName,
                    message: `Step not found for qadam ${qadamName}@${qadamVersion}`,
                    extra: { qadamName, qadamVersion },
                },
            })
        }

        const property = (actionOrTrigger.props as QadamPropertyMap)[propertyName]

        if (isNil(property)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'config',
                    entityId: propertyName,
                    message: `Config not found for step ${actionOrTriggerName} in qadam ${qadamName}@${qadamVersion}`,
                    extra: { qadamName, qadamVersion, stepName: actionOrTriggerName },
                },
            })
        }

        return { property, qadam }
    },

    getPackageAlias: ({ qadamName, qadamVersion, devQadams }: GetPackageAliasParams) => {
        if (devQadams.includes(getQadamNameFromAlias(qadamName))) {
            return qadamName
        }

        return getPackageAliasForQadam({
            qadamName,
            qadamVersion,
        })
    },

    getQadamPath: async ({ packageName, devQadams }: GetQadamPathParams): Promise<string> => {
        const isDevQadam = devQadams.includes(getQadamNameFromAlias(packageName))
        if (isDevQadam) {
            return resolveQadamPath({ packageName, isDevQadam })
        }

        const cached = qadamPathCache.get(packageName)
        if (!isNil(cached)) {
            return cached
        }

        const resolving = resolveQadamPath({ packageName, isDevQadam })
        qadamPathCache.set(packageName, resolving)
        // A miss is not permanent: an ARCHIVE/CUSTOM qadam can be installed later in this process.
        void resolving.catch(() => {
            if (qadamPathCache.get(packageName) === resolving) {
                qadamPathCache.delete(packageName)
            }
        })
        return resolving
    },
}

async function resolveQadamPath({ packageName, isDevQadam }: ResolveQadamPathParams): Promise<string> {
    if (isDevQadam) {
        const devPath = await findInDistFolder({ packageName, refreshIndex: true })
        if (!isNil(devPath)) {
            return devPath
        }
    }
    // #503: an installed copy at the SAME `name@version` as a bundled build is never a legitimate
    // provider — official qadams are not installed (`needsInstalling` in the worker), so the only
    // way that directory exists is a CUSTOM qadam a platform registered under an official name,
    // landing in the workspace every tenant shares. The bundled build wins outright there. An
    // installed copy at a DIFFERENT version keeps winning: that is the side-by-side case #477
    // needs once official versions are registry-installed next to the bundled one.
    const bundledAtSameVersion = await findBundledBuildAtAliasVersion(packageName)
    if (!isNil(bundledAtSameVersion)) {
        return bundledAtSameVersion
    }
    const installedPath = await traverseAllParentFoldersToFindQadam(packageName)
    if (!isNil(installedPath)) {
        return installedPath
    }
    const bundledPath = await findInDistFolder({ packageName, refreshIndex: false })
    if (!isNil(bundledPath)) {
        return bundledPath
    }
    throw new EngineGenericError('QadamNotFoundError', `Qadam not found for package: ${packageName}`)
}

async function findBundledBuildAtAliasVersion(packageName: string): Promise<string | null> {
    const name = trimVersionFromAlias(packageName)
    const version = packageName.slice(name.length + 1)
    if (!SEMVER_PATTERN.test(version)) {
        return null
    }
    const distIndex = await getDistIndex({ refresh: false })
    const bundled = distIndex.get(name)
    if (isNil(bundled) || bundled.version !== version) {
        return null
    }
    return bundled.indexPath
}

async function findInDistFolder({ packageName, refreshIndex }: FindInDistFolderParams): Promise<string | null> {
    const distIndex = await getDistIndex({ refresh: refreshIndex })
    const target = trimVersionFromAlias(packageName)
    return (distIndex.get(packageName) ?? distIndex.get(target))?.indexPath ?? null
}

async function getDistIndex({ refresh }: { refresh: boolean }): Promise<Map<string, DistPackageEntry>> {
    if (!refresh && !isNil(distIndexCache)) {
        return distIndexCache
    }
    const building = buildDistIndex()
    distIndexCache = building
    void building.catch(() => {
        if (distIndexCache === building) {
            distIndexCache = null
        }
    })
    return building
}

async function buildDistIndex(): Promise<Map<string, DistPackageEntry>> {
    const sourceQadamsPath = path.resolve('packages/qadams')
    if (!await utils.folderExists(sourceQadamsPath)) {
        return new Map()
    }
    const distPackageJsonPaths = await findDistPackageJsonFiles(sourceQadamsPath)
    const entries = await Promise.all(distPackageJsonPaths.map(readDistPackageEntry))

    const distIndex = new Map<string, DistPackageEntry>()
    for (const entry of entries) {
        // First match wins, matching the order the sequential scan used to return in.
        if (!isNil(entry) && !distIndex.has(entry.name)) {
            distIndex.set(entry.name, entry)
        }
    }
    return distIndex
}

async function readDistPackageEntry(packageJsonPath: string): Promise<DistPackageEntry | null> {
    const { data } = await utils.tryCatchAndThrowOnEngineError(async () => {
        const content = await fs.readFile(packageJsonPath, 'utf-8')
        const parsed = distPackageJsonSchema.safeParse(JSON.parse(content))
        if (!parsed.success) {
            return null
        }
        return {
            name: parsed.data.name,
            version: parsed.data.version ?? null,
            indexPath: path.join(path.dirname(packageJsonPath), 'src', 'index.js'),
        }
    })
    return data ?? null
}

async function findDistPackageJsonFiles(dirPath: string): Promise<string[]> {
    const results: string[] = []
    const ignoredDirs = ['node_modules', '.turbo', 'framework', 'common']

    async function scanDir(currentPath: string): Promise<void> {
        const items = await fs.readdir(currentPath, { withFileTypes: true })
        for (const item of items) {
            if (!item.isDirectory() || ignoredDirs.includes(item.name)) {
                continue
            }
            const fullPath = path.join(currentPath, item.name)
            if (item.name === 'dist') {
                const pkgJson = path.join(fullPath, 'package.json')
                if (await utils.folderExists(pkgJson)) {
                    results.push(pkgJson)
                }
            }
            else {
                await scanDir(fullPath)
            }
        }
    }

    await scanDir(dirPath)
    return results
}


async function traverseAllParentFoldersToFindQadam(packageName: string): Promise<string | null> {
    const customPaths = (process.env.AP_CUSTOM_PIECES_PATHS ?? '').split(':').filter(Boolean)
    for (const customPath of customPaths) {
        const qadamPath = path.resolve(customPath, 'qadams', packageName, 'node_modules', trimVersionFromAlias(packageName))
        if (await utils.folderExists(qadamPath)) {
            return path.join(qadamPath, 'src', 'index.js')
        }
    }

    const rootDir = path.parse(__dirname).root
    let currentDir = __dirname
    const maxIterations = currentDir.split(path.sep).length
    for (let i = 0; i < maxIterations; i++) {
        const qadamPath = path.resolve(currentDir, 'qadams', packageName, 'node_modules', trimVersionFromAlias(packageName))

        if (await utils.folderExists(qadamPath)) {
            return path.join(qadamPath, 'src', 'index.js')
        }

        const parentDir = path.dirname(currentDir)
        if (parentDir === currentDir || currentDir === rootDir) {
            break
        }
        currentDir = parentDir
    }
    return null
}

type DistPackageEntry = {
    name: string
    // `null` when the bundled package.json carries no version — such a build can never claim an
    // alias's version, so it never wins the #503 same-version check.
    version: string | null
    indexPath: string
}

type ResolveQadamPathParams = {
    packageName: string
    isDevQadam: boolean
}

type FindInDistFolderParams = {
    packageName: string
    refreshIndex: boolean
}

type GetQadamPathParams = {
    packageName: string
    devQadams: string[]
}

type LoadPieceParams = {
    qadamName: string
    qadamVersion: string
    devQadams: string[]
}

type GetQadamAndTriggerParams = {
    qadamName: string
    qadamVersion: string
    triggerName: string
    devQadams: string[]
}

type GetQadamAndActionParams = {
    qadamName: string
    qadamVersion: string
    actionName: string
    devQadams: string[]
}

type GetPropParams = {
    qadamName: string
    qadamVersion: string
    actionOrTriggerName: string
    propertyName: string
    devQadams: string[]
}

type GetPackageAliasParams = {
    qadamName: string
    devQadams: string[]
    qadamVersion: string
}

