import fs from 'fs/promises'
import path from 'path'
import { Action, Qadam, QadamPropertyMap, Trigger } from '@aiqadam/qadams-framework'
import { EngineGenericError, ErrorCode, extractQadamFromModule, getPackageAliasForQadam, getQadamNameFromAlias, isNil, QadamFlowError, trimVersionFromAlias, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { z } from 'zod'
import { utils } from '../utils'

// Bundled qadams are baked into the image, so a resolved path cannot change while the
// process lives. Both caches hold the in-flight promise so concurrent steps share one walk.
const qadamPathCache = new Map<string, Promise<string>>()
let distIndexCache: Promise<Map<string, DistPackageEntry>> | null = null
// #419 Phase 0: which resolved qadam paths already had a cold-load line logged. Keyed by the
// resolved path rather than the (qadamName, qadamVersion) a caller asked for, because a
// stale-pinned alias falls back to the same bundled dist file (#503) — the import cost is paid
// once per (process x resolved file), so the log fires once for that, not once per alias. Set
// synchronously right after `getQadamPath` resolves and before any further `await`, so two calls
// racing on the same brand-new path cannot both observe it as cold.
const loggedColdQadamPaths = new Set<string>()
// Exact `x.y.z` aliases only (`name-1.2.3`): that is the shape the API accepts for a pinned
// version (`ExactVersionType`), and `trimVersionFromAlias` splits on the last hyphen, so a
// prerelease tail could not be recovered here anyway. A dev qadam is resolved by bare name and
// has no version to compare.
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
// `version` tolerated as missing or null so a package.json the old name-only index accepted stays
// resolvable; it just never wins the same-version check.
const distPackageJsonSchema = z.object({ name: z.string(), version: z.string().nullish() })
const resolvedQadamPackageJsonSchema = z.object({ version: z.string() })

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
            const resolveStart = performance.now()
            const qadamPath = await qadamLoader.getQadamPath({ packageName, devQadams })
            const resolveMs = performance.now() - resolveStart

            // Cold vs. warm decides only whether the line below gets logged — Node's own module
            // cache makes every import of an already-seen path cheap regardless.
            const isColdLoad = !loggedColdQadamPaths.has(qadamPath)
            if (isColdLoad) {
                loggedColdQadamPaths.add(qadamPath)
            }
            const sharedDepsAlreadyLoaded = isColdLoad ? isQadamsFrameworkAlreadyLoaded(qadamPath) : false

            const importStart = performance.now()
            const { data: module, error: importError } = await tryCatch(() => import(qadamPath))
            const importMs = performance.now() - importStart
            if (importError) {
                // A failed cold attempt must not permanently mark the path as "seen" — a later,
                // successful import of the same path (e.g. after a transient failure) still needs
                // its own cold-load line. Only ever un-mark our own cold claim: a warm path
                // (isColdLoad false) that fails here was already imported successfully once, and
                // Node's own module cache means a retry would resolve from cache anyway — the
                // failure is unrelated to import cost and must not turn a warm path cold again.
                if (isColdLoad) {
                    loggedColdQadamPaths.delete(qadamPath)
                }
                throw importError
            }

            if (isColdLoad) {
                const resolvedVersion = await resolveLoadedQadamVersion(qadamPath)
                logColdQadamLoad({ qadamName, qadamVersion, resolvedVersion, resolveMs, importMs, sharedDepsAlreadyLoaded })
            }

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

// #419 Phase 0: whether the bundled qadams-framework dist entry was already in the CJS module
// cache BEFORE this import — i.e. some earlier qadam import in this process already pulled it in.
// Read straight off `require.cache`; never pre-require it as a probe, which would load it itself
// and make every load report `true`.
//
// Resolved from the QADAM's own directory, not the engine's — the engine ships as one bundled
// file (`dist/packages/engine/main.js`, copied to a cache path with no `node_modules` of its own),
// while bun installs `@aiqadam/qadams-framework` next to each qadam's own `dist/src/index.js`
// (verified against the real image: `require.resolve` from the engine's own location fails to
// find it at all). Every bundled qadam's local symlink still realpaths to the same framework
// file, so `require.cache` correctly reflects a hit made through a different qadam's own symlink.
function isQadamsFrameworkAlreadyLoaded(qadamPath: string): boolean {
    const { data } = tryCatchSync(() => {
        const resolved = require.resolve('@aiqadam/qadams-framework', { paths: [path.dirname(qadamPath)] })
        return require.cache[resolved]
    })
    return !isNil(data)
}

// #419 Phase 0: the version actually loaded, as opposed to `qadam` below (the requested
// name@version) — a stale-pinned alias (e.g. `qadam-tables@0.3.1`) can fall through to a newer
// bundled dist (#503). Read from the resolved package's own `package.json`, which always sits two
// directories above its `dist/src/index.js` entry point (`buildDistIndex` and
// `traverseAllParentFoldersToFindQadam` both lay out `<package root>/package.json` next to
// `<package root>/src/index.js`). `null` when unreadable, rather than falling back to any part of
// `qadamPath` itself: an installed/ARCHIVE qadam's path can carry a platform- or tenant-specific
// segment, and this line must never leak one.
async function resolveLoadedQadamVersion(qadamPath: string): Promise<string | null> {
    const { data } = await tryCatch(async () => {
        const packageJsonPath = path.join(path.dirname(path.dirname(qadamPath)), 'package.json')
        const content = await fs.readFile(packageJsonPath, 'utf-8')
        return resolvedQadamPackageJsonSchema.parse(JSON.parse(content)).version
    })
    return data ?? null
}

function logColdQadamLoad({ qadamName, qadamVersion, resolvedVersion, resolveMs, importMs, sharedDepsAlreadyLoaded }: LogColdQadamLoadParams): void {
    console.log(`[qadamLoader] cold load ${JSON.stringify({
        qadam: `${qadamName}@${qadamVersion}`,
        resolvedVersion,
        resolveMs: roundMs(resolveMs),
        importMs: roundMs(importMs),
        sharedDepsAlreadyLoaded,
    })}`)
}

function roundMs(value: number): number {
    return Math.round(value * 10) / 10
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
    if (!EXACT_VERSION_PATTERN.test(version)) {
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
    // `null` when the bundled package.json carries no usable version — such a build can never
    // claim an alias's version, so it never wins the #503 same-version check.
    version: string | null
    indexPath: string
}

type LogColdQadamLoadParams = {
    qadamName: string
    qadamVersion: string
    resolvedVersion: string | null
    resolveMs: number
    importMs: number
    sharedDepsAlreadyLoaded: boolean
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

