import fs from 'fs/promises'
import path from 'path'
import { Action, Qadam, QadamPropertyMap, Trigger } from '@aiqadam/qadams-framework'
import { EngineGenericError, ErrorCode, extractQadamFromModule, getLegacyPackageAliasForQadam, getPackageAliasForQadam, getQadamNameFromAlias, isNil, QadamFlowError, qadamVersionParser, trimVersionFromAlias, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { z } from 'zod'
import { utils } from '../utils'
import { qadamDistIndex } from './qadam-dist-index'
import { qadamPlatformModules } from './qadam-platform-modules'
import { qadamVersionStoreResolver } from './qadam-version-store-resolver'

// Bundled qadams are baked into the image and a stored version is never overwritten, so a resolved
// path cannot change while the process lives. The cache holds the in-flight promise so concurrent
// steps share one walk.
const qadamPathCache = new Map<string, Promise<ResolvedQadam>>()
// #419 Phase 0: which resolved qadam paths already had a cold-load line logged. Keyed by the
// resolved path rather than the (qadamName, qadamVersion) a caller asked for, because a
// stale-pinned alias falls back to the same bundled dist file (#503) — the import cost is paid
// once per (process x resolved file), so the log fires once for that, not once per alias. Set
// synchronously right after `getQadamPath` resolves and before any further `await`, so two calls
// racing on the same brand-new path cannot both observe it as cold.
const loggedColdQadamPaths = new Set<string>()
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
            const { path: qadamPath, source } = await resolveQadam({ packageName, devQadams })
            const resolveMs = performance.now() - resolveStart

            // Cold vs. warm decides only whether the line below gets logged — Node's own module
            // cache makes every import of an already-seen path cheap regardless.
            const isColdLoad = !loggedColdQadamPaths.has(qadamPath)
            if (isColdLoad) {
                loggedColdQadamPaths.add(qadamPath)
            }
            const sharedDepsAlreadyLoaded = isColdLoad ? isQadamsFrameworkAlreadyLoaded({ qadamPath, source }) : false

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
                logColdQadamLoad({ qadamName, qadamVersion, resolvedVersion, source, resolveMs, importMs, sharedDepsAlreadyLoaded })
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
        return (await resolveQadam({ packageName, devQadams })).path
    },
}

async function resolveQadam({ packageName, devQadams }: GetQadamPathParams): Promise<ResolvedQadam> {
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
// A stored version has no `node_modules` of its own to resolve it from; it gets the platform's copy
// (`qadamPlatformModules`).
function isQadamsFrameworkAlreadyLoaded({ qadamPath, source }: { qadamPath: string, source: QadamSource }): boolean {
    const { data } = tryCatchSync(() => {
        const resolved = source === QadamSource.STORE
            ? qadamPlatformModules.resolve({ specifier: '@aiqadam/qadams-framework' })
            : require.resolve('@aiqadam/qadams-framework', { paths: [path.dirname(qadamPath)] })
        return require.cache[resolved]
    })
    return !isNil(data)
}

// #419 Phase 0: the version actually loaded, as opposed to `qadam` below (the requested
// name@version) — a stale-pinned alias (e.g. `qadam-tables@0.3.1`) can fall through to a newer
// bundled dist (#503). Read from the resolved package's own `package.json`, which always sits two
// directories above the entry point regardless of which layout resolved it: `dist/src/index.js`
// for bundled and dev qadams (`qadamDistIndex`), `<pkg>/src/index.js` for installed ones
// (`traverseAllParentFoldersToFindQadam`) — either way, `package.json` is the entry file's `src`
// directory's own sibling. `null` when unreadable, rather than falling back to any part of
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

function logColdQadamLoad({ qadamName, qadamVersion, resolvedVersion, source, resolveMs, importMs, sharedDepsAlreadyLoaded }: LogColdQadamLoadParams): void {
    console.log(`[qadamLoader] cold load ${JSON.stringify({
        qadam: `${qadamName}@${qadamVersion}`,
        resolvedVersion,
        source,
        resolveMs: roundMs(resolveMs),
        importMs: roundMs(importMs),
        sharedDepsAlreadyLoaded,
    })}`)
}

// A job that is first to build the dist index is the one that paid for a rejected manifest's scan,
// so its own log is the right place to say why.
function warnOnConsole(line: string): void {
    console.warn(line)
}

function roundMs(value: number): number {
    return Math.round(value * 10) / 10
}

async function resolveQadamPath({ packageName, isDevQadam }: ResolveQadamPathParams): Promise<ResolvedQadam> {
    if (isDevQadam) {
        const devPath = await findInDistFolder({ packageName, refreshIndex: true })
        if (!isNil(devPath)) {
            return { path: devPath, source: QadamSource.DEV }
        }
    }
    // ADR-0003: the store holds the pinned version's own code, so it comes first. A version it does
    // not hold falls through to the image's build, as before the store (#779 keeps that until #808's
    // checked fallback exists).
    const pin = splitExactAlias(packageName)
    const storedPath = isNil(pin) ? null : await qadamVersionStoreResolver.findOfficialEntryPoint(pin)
    if (!isNil(storedPath)) {
        return { path: storedPath, source: QadamSource.STORE }
    }
    // #503: an installed copy at the SAME `name@version` as a bundled build is never a legitimate
    // provider — official qadams are not installed (`needsInstalling` in the worker), so the only
    // way that directory exists is a CUSTOM qadam a platform registered under an official name,
    // landing in the workspace every tenant shares. The bundled build wins outright there. An
    // installed copy at a DIFFERENT version keeps winning: that is the side-by-side case #477
    // needs once official versions are registry-installed next to the bundled one.
    const bundledAtSameVersion = isNil(pin) ? null : await findBundledBuildAtVersion(pin)
    if (!isNil(bundledAtSameVersion)) {
        return { path: bundledAtSameVersion, source: QadamSource.BUNDLED }
    }
    const installedPath = await traverseAllParentFoldersToFindQadam(packageName)
    if (!isNil(installedPath)) {
        return { path: installedPath, source: QadamSource.INSTALLED }
    }
    const bundledPath = await findInDistFolder({ packageName, refreshIndex: false })
    if (!isNil(bundledPath)) {
        return { path: bundledPath, source: QadamSource.BUNDLED }
    }
    throw new EngineGenericError('QadamNotFoundError', `Qadam not found for package: ${packageName}`)
}

// A release `name@1.2.3` or a snapshot `name@1.3.0-main.412` (ADR-0004), or the legacy
// `name-1.2.3` an older caller may still hand over. A dev qadam is resolved by bare name and has no
// version to compare.
function splitExactAlias(packageName: string): ExactPin | null {
    const alias = qadamVersionParser.parseAlias({ alias: packageName })
    return isNil(alias) ? null : { name: alias.name, version: alias.version }
}

async function findBundledBuildAtVersion({ name, version }: ExactPin): Promise<string | null> {
    const distIndex = await qadamDistIndex.get({ refresh: false, warn: warnOnConsole })
    const bundled = distIndex.get(name)
    if (isNil(bundled) || bundled.version !== version) {
        return null
    }
    return bundled.indexPath
}

async function findInDistFolder({ packageName, refreshIndex }: FindInDistFolderParams): Promise<string | null> {
    const distIndex = await qadamDistIndex.get({ refresh: refreshIndex, warn: warnOnConsole })
    const target = trimVersionFromAlias(packageName)
    return (distIndex.get(packageName) ?? distIndex.get(target))?.indexPath ?? null
}

async function traverseAllParentFoldersToFindQadam(packageName: string): Promise<string | null> {
    const customPaths = (process.env.AP_CUSTOM_PIECES_PATHS ?? '').split(':').filter(Boolean)
    const memberDirectoryNames = listWorkspaceMemberDirectoryNames({ packageName })
    const qadamName = trimVersionFromAlias(packageName)
    for (const customPath of customPaths) {
        for (const memberDirectoryName of memberDirectoryNames) {
            const qadamPath = path.resolve(customPath, 'qadams', memberDirectoryName, 'node_modules', qadamName)
            if (await utils.folderExists(qadamPath)) {
                return path.join(qadamPath, 'src', 'index.js')
            }
        }
    }

    const rootDir = path.parse(__dirname).root
    let currentDir = __dirname
    const maxIterations = currentDir.split(path.sep).length
    for (let i = 0; i < maxIterations; i++) {
        for (const memberDirectoryName of memberDirectoryNames) {
            const qadamPath = path.resolve(currentDir, 'qadams', memberDirectoryName, 'node_modules', qadamName)
            if (await utils.folderExists(qadamPath)) {
                return path.join(qadamPath, 'src', 'index.js')
            }
        }

        const parentDir = path.dirname(currentDir)
        if (parentDir === currentDir || currentDir === rootDir) {
            break
        }
        currentDir = parentDir
    }
    return null
}

// The worker installs a qadam into `qadams/<name>@<version>`; workspaces installed before ADR-0004
// hold `qadams/<name>-<version>`. The current name is tried first, the legacy one is a read path
// only: nothing here ever creates it.
function listWorkspaceMemberDirectoryNames({ packageName }: { packageName: string }): string[] {
    const alias = qadamVersionParser.parseAlias({ alias: packageName })
    if (isNil(alias)) {
        return [packageName]
    }
    return [
        getPackageAliasForQadam({ qadamName: alias.name, qadamVersion: alias.version }),
        getLegacyPackageAliasForQadam({ qadamName: alias.name, qadamVersion: alias.version }),
    ]
}

// Where a loaded qadam came from, on the cold-load line. Never the path itself (see below).
enum QadamSource {
    DEV = 'dev',
    STORE = 'store',
    BUNDLED = 'bundled',
    INSTALLED = 'installed',
}

type ResolvedQadam = {
    path: string
    source: QadamSource
}

type ExactPin = {
    name: string
    version: string
}

type LogColdQadamLoadParams = {
    qadamName: string
    qadamVersion: string
    resolvedVersion: string | null
    source: QadamSource
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

