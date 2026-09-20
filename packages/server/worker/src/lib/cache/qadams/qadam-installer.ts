import { rm, writeFile } from 'node:fs/promises'
import path, { dirname, join } from 'node:path'
import { fileLock, fileSystemUtils } from '@aiqadam/server-utils'
import {
    ExecutionMode,
    getQadamNameFromAlias,
    groupBy,
    isEmpty,
    isNil,
    PackageType,
    PrivateQadamPackage,
    QadamPackage,
    QadamType,
    tryCatch,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { trace } from '@opentelemetry/api'
import { Logger } from 'pino'
import writeFileAtomic from 'write-file-atomic'
import { workerSettings } from '../../config/worker-settings'
import { getGlobalCacheCommonPath, getGlobalCachePathLatestVersion } from '../cache-paths'
import { bunRunner } from '../code/bun-runner'

const tracer = trace.getTracer('qadam-installer')

const usedQadamsMemoryCache: Record<string, boolean> = {}
// The workspaces glob in createRootPackageJson has to address this same directory. When the two
// drifted apart (the glob still said `pieces/**` after the rename), bun matched no workspace,
// exited 0 with "No packages!", and created no node_modules — so qadamCheckIfAlreadyInstalled
// deleted the `ready` marker and every job reinstalled from scratch, forever.
const QADAMS_DIR = 'qadams'
const relativeQadamPath = (piece: QadamPackage) => join('./', QADAMS_DIR, `${piece.qadamName}-${piece.qadamVersion}`)
const qadamPath = (rootWorkspace: string, piece: QadamPackage) => join(rootWorkspace, QADAMS_DIR, `${piece.qadamName}-${piece.qadamVersion}`)

export const qadamInstaller = (log: Logger, apiClient: WorkerToApiContract) => ({
    async install({ pieces, includeFilters }: InstallParams): Promise<void> {
        const groupedQadams = groupQadamsByPackagePath(pieces)
        const installPromises = Object.entries(groupedQadams).map(async ([packagePath, qadamsInGroup]) => {
            await installQadams(packagePath, qadamsInGroup, includeFilters, log, apiClient)
        })
        await Promise.all(installPromises)
    },

    getCustomPiecesPath,
})

function getCustomPiecesPath(platformId: string): string {
    switch (workerSettings.getSettings().EXECUTION_MODE) {
        case ExecutionMode.SANDBOX_PROCESS:
        case ExecutionMode.SANDBOX_CODE_AND_PROCESS:
            return path.resolve(getGlobalCachePathLatestVersion(), 'custom_pieces', platformId)
        case ExecutionMode.UNSANDBOXED:
        case ExecutionMode.SANDBOX_CODE_ONLY:
            return getGlobalCacheCommonPath()
        default:
            throw new Error('Invalid execution mode')
    }
}

async function installQadams(rootWorkspace: string, pieces: QadamPackage[], includeFilters: boolean, log: Logger, apiClient: WorkerToApiContract): Promise<void> {
    const devQadams = workerSettings.getSettings().DEV_QADAMS
    const officialQadamsInstallEnabled = workerSettings.getSettings().OFFICIAL_QADAMS_INSTALL_ENABLED
    const nonDevQadams = pieces.filter(piece => !devQadams.includes(getQadamNameFromAlias(piece.qadamName)))
    const installableQadams = nonDevQadams.filter(piece => needsInstalling({ piece, officialQadamsInstallEnabled }))
    const { qadamsToInstall } = await partitionQadamsToInstall(rootWorkspace, installableQadams)

    if (isEmpty(qadamsToInstall)) {
        log.debug({ rootWorkspace }, '[qadamInstaller] No new qadams to install (already installed)')
        return
    }
    log.info({
        rootWorkspace,
        qadamsToInstall: qadamsToInstall.map(piece => `${piece.qadamName}-${piece.qadamVersion}`),
    }, '[qadamInstaller] Installing qadams in workspace')

    // rootWorkspace is a shared cache directory bind-mounted into every worker replica
    // (docker-compose.yml runs several worker containers against the same host path), so an
    // in-process memoryLock here would only serialize installs within one container — two
    // replicas installing the same not-yet-cached qadam at the same time would still race on
    // the files underneath. fileLock puts the lock on disk next to rootWorkspace itself, which
    // every replica sharing that mount observes.
    await fileLock.runExclusive({
        path: rootWorkspace,
        fn: async () => {
            const { qadamsToInstall } = await partitionQadamsToInstall(rootWorkspace, installableQadams)
            if (isEmpty(qadamsToInstall)) {
                log.info({ rootWorkspace }, '[qadamInstaller] No new qadams to install in lock (already installed)')
                return
            }
            log.info({
                rootWorkspace,
                pieces: qadamsToInstall.map(piece => `${piece.qadamName}-${piece.qadamVersion}`),
            }, '[qadamInstaller] acquired lock and starting to install qadams')

            await createRootPackageJson({
                path: rootWorkspace,
            })

            await savePackageArchivesToDiskIfNotCached(rootWorkspace, qadamsToInstall, apiClient)

            await Promise.all(qadamsToInstall.map(piece => createQadamPackageJson({
                rootWorkspace,
                qadamPackage: piece,
            })))

            await tracer.startActiveSpan('qadamInstaller.bunInstall', async (span) => {
                try {
                    span.setAttribute('qadams.count', qadamsToInstall.length)
                    span.setAttribute('qadams.rootWorkspace', rootWorkspace)

                    const { error: batchError } = await tryCatch(async () => bunRunner(log).install({
                        path: rootWorkspace,
                        filtersPath: includeFilters ? qadamsToInstall.map(relativeQadamPath) : [],
                    }))

                    if (isNil(batchError)) {
                        await markQadamsAsUsed(rootWorkspace, qadamsToInstall)
                        log.info({
                            rootWorkspace,
                            qadamsCount: qadamsToInstall.length,
                        }, '[qadamInstaller] Installed registry qadams using bun')
                        return
                    }

                    span.recordException(batchError instanceof Error ? batchError : new Error(String(batchError)))

                    if (qadamsToInstall.length === 1) {
                        log.error({ rootWorkspace, error: batchError }, '[qadamInstaller] Qadam installation failed, rolling back')
                        await rollbackInstallation(rootWorkspace, qadamsToInstall)
                        throw batchError
                    }

                    log.warn({
                        rootWorkspace,
                        pieces: qadamsToInstall.map(piece => `${piece.qadamName}-${piece.qadamVersion}`),
                        error: batchError,
                    }, '[qadamInstaller] Batch install failed, retrying qadams individually')

                    const failedQadams = await tryInstallQadamsIndividually(rootWorkspace, qadamsToInstall, log)

                    if (failedQadams.length > 0) {
                        const names = failedQadams.map(p => `${p.qadamName}@${p.qadamVersion}`).join(', ')
                        throw new Error(`[qadamInstaller] Failed to install: ${names}`)
                    }

                    log.info({
                        rootWorkspace,
                        qadamsCount: qadamsToInstall.length,
                    }, '[qadamInstaller] Installed registry qadams using bun (individual fallback)')
                }
                finally {
                    span.end()
                }
            })
        },
    })
}

// Official qadams are compiled into the image (`Dockerfile`: "Qadams must be pre-compiled because
// the runtime loader scans <qadam>/dist/ in standalone mode (no cloud registry)") and the engine's
// loader falls back to `packages/qadams/**/dist` for exactly that reason.
//
// DO NOT flip `OFFICIAL_QADAMS_INSTALL_ENABLED` on in any environment, including staging, until
// #482 is closed. The `@aiqadam` npm scope is UNCLAIMED — `.npmrc` maps only `@activepieces`, so
// every `@aiqadam/*` name resolves against public npm today, and nobody has registered it yet.
// That is not a stable "it 404s" state, it is a dependency-confusion target sitting open: the
// moment anyone squats the scope and publishes any of these names, this predicate starts routing
// the ENTIRE official catalogue through `bun install` against a package chosen by an attacker, not
// an administrator. `createQadamPackageJson` writes it straight into a package.json dependency and
// `bunRunner.install` fetches it. It lands in the SHARED workspace (`getGlobalCacheCommonPath()`,
// not a per-platform path — see `groupQadamsByPackagePath`), the engine prefers an installed
// directory over the bundled `dist` build, and the substituted code then runs for every tenant on
// that worker. Two mitigations that look like they'd cover this and do not, so nobody re-derives
// and re-rejects them: `bun install --ignore-scripts` (`bun-runner.ts`) blocks `postinstall`, but
// the qadam is `require`d by the engine rather than run via a lifecycle script, so that is not the
// vector; and the repo-root `bunfig.toml`'s `minimumReleaseAge` quarantine is not in force here,
// because bun reads `bunfig.toml` from the install cwd and `$HOME` and does not walk up the tree,
// and the install cwd (`cache/v12/common`) has none. See #482 for what has to land first (claiming
// the org, pinning `@aiqadam:registry` explicitly, carrying the quarantine into the install cwd).
//
// #433/#477 decided that official qadams become real published packages so a version pin survives
// an image upgrade instead of resolving to whatever happens to be built. Once #475/#476 publish
// them AND #482's preconditions are met, flipping this flag routes OFFICIAL qadams through this
// same install path a CUSTOM qadam already takes — `qadam-cache.ts`'s `name@version` shadowing has
// to flip with it, or the DB history this unlocks is discarded before it can be used. Landing this
// flip before the packages are actually published breaks every existing flow's install (today,
// harmlessly, with a 404); after the scope is squatted it would not be harmless — which is why the
// flag defaults to off regardless. A custom qadam is installed either way: an ARCHIVE resolves
// from a tarball on disk, and a CUSTOM registry package names something an administrator chose and
// that really is published, so both have to be installed for the engine to find them at all.
function needsInstalling({ piece, officialQadamsInstallEnabled }: {
    piece: QadamPackage
    officialQadamsInstallEnabled: boolean
}): boolean {
    if (piece.packageType === PackageType.ARCHIVE || piece.qadamType === QadamType.CUSTOM) {
        return true
    }
    // `piece.qadamType === QadamType.OFFICIAL` is always true once the CUSTOM branch above has
    // already returned — `QadamType` has exactly two members. Kept explicit rather than
    // `return officialQadamsInstallEnabled` so the predicate still reads correctly if a third
    // `QadamType` is ever added; it is deliberate belt-and-braces, not dead code.
    return officialQadamsInstallEnabled && piece.qadamType === QadamType.OFFICIAL
}

async function rollbackInstallation(rootWorkspace: string, pieces: QadamPackage[]): Promise<void> {
    await Promise.all(pieces.map(piece => rm(path.resolve(rootWorkspace, relativeQadamPath(piece)), {
        recursive: true,
        force: true,
    })))
}

async function tryInstallQadamsIndividually(
    rootWorkspace: string,
    pieces: QadamPackage[],
    log: Logger,
): Promise<QadamPackage[]> {
    const failures: QadamPackage[] = []
    for (const piece of pieces) {
        const { error } = await tryCatch(async () =>
            bunRunner(log).install({
                path: rootWorkspace,
                filtersPath: [relativeQadamPath(piece)],
            }),
        )
        if (error) {
            log.error({
                piece: `${piece.qadamName}@${piece.qadamVersion}`,
                error,
            }, '[qadamInstaller] Individual qadam installation failed, rolling back')
            await rollbackInstallation(rootWorkspace, [piece])
            failures.push(piece)
        }
        else {
            await markQadamsAsUsed(rootWorkspace, [piece])
        }
    }
    return failures
}

function groupQadamsByPackagePath(pieces: QadamPackage[]): Record<string, QadamPackage[]> {
    return groupBy(pieces, (piece) => {
        switch (piece.packageType) {
            case PackageType.ARCHIVE:
                return getCustomPiecesPath(piece.platformId)
            case PackageType.REGISTRY: {
                if (piece.qadamType === QadamType.CUSTOM && !isNil(piece.platformId)) {
                    return getCustomPiecesPath(piece.platformId)
                }
                return getGlobalCacheCommonPath()
            }
            default:
                throw new Error('Invalid package type')
        }
    })
}

async function savePackageArchivesToDiskIfNotCached(
    rootWorkspace: string,
    pieces: QadamPackage[],
    apiClient: WorkerToApiContract,
): Promise<void> {
    const saveToDiskJobs = pieces.map(async (piece) => {
        if (piece.packageType !== PackageType.ARCHIVE) {
            return
        }
        const archivePath = getPackageArchivePathForQadam(rootWorkspace, piece)
        if (await fileSystemUtils.fileExists(archivePath)) {
            return
        }
        await fileSystemUtils.threadSafeMkdir(dirname(archivePath))
        const archive = await apiClient.getQadamArchive({ archiveId: piece.archiveId })
        await writeFile(archivePath, archive)
    })
    await Promise.all(saveToDiskJobs)
}

async function createRootPackageJson({ path }: { path: string }): Promise<void> {
    const packageJsonPath = join(path, 'package.json')
    await fileSystemUtils.threadSafeMkdir(dirname(packageJsonPath))
    await writeFileAtomic(packageJsonPath, JSON.stringify({
        'name': 'fast-workspace',
        'version': '1.0.0',
        'workspaces': [
            `${QADAMS_DIR}/**`,
        ],
    }, null, 2), 'utf8')
}

async function createQadamPackageJson({ rootWorkspace, qadamPackage }: {
    rootWorkspace: string
    qadamPackage: QadamPackage
}): Promise<void> {
    const packageJsonPath = join(qadamPath(rootWorkspace, qadamPackage), 'package.json')

    const packageJson = {
        'name': `${qadamPackage.qadamName}-${qadamPackage.qadamVersion}`,
        'version': `${qadamPackage.qadamVersion}`,
        'dependencies': {
            [qadamPackage.qadamName]: qadamPackage.packageType === PackageType.REGISTRY ? qadamPackage.qadamVersion : getPackageArchivePathForQadam(rootWorkspace, qadamPackage),
        },
    }
    await fileSystemUtils.threadSafeMkdir(dirname(packageJsonPath))
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8')
}

async function partitionQadamsToInstall(rootWorkspace: string, pieces: QadamPackage[]): Promise<QadamInstallationResult> {
    const qadamsWithCheck = await Promise.all(
        pieces.map(async (piece) => {
            const installed = await qadamCheckIfAlreadyInstalled(rootWorkspace, piece)
            return { piece, installed }
        }),
    )

    const qadamsToInstall = qadamsWithCheck.filter(({ installed }) => !installed).map(({ piece }) => piece)

    return {
        qadamsToInstall,
    }
}

async function qadamCheckIfAlreadyInstalled(rootWorkspace: string, piece: QadamPackage): Promise<boolean> {
    const qadamFolder = qadamPath(rootWorkspace, piece)
    if (usedQadamsMemoryCache[qadamFolder]) {
        return true
    }
    const readyExists = await fileSystemUtils.fileExists(join(qadamFolder, 'ready'))
    if (!readyExists) {
        return false
    }
    const nodeModulesExist = await fileSystemUtils.fileExists(join(qadamFolder, 'node_modules'))
    if (!nodeModulesExist) {
        await rm(join(qadamFolder, 'ready'), { force: true })
        return false
    }
    usedQadamsMemoryCache[qadamFolder] = true
    return true
}

async function markQadamsAsUsed(rootWorkspace: string, pieces: QadamPackage[]): Promise<void> {
    const writeToDiskJobs = pieces.map(async (piece) => {
        const qadamFolder = qadamPath(rootWorkspace, piece)
        await fileSystemUtils.threadSafeMkdir(qadamFolder)
        await writeFileAtomic(
            join(qadamFolder, 'ready'),
            'true',
        )
    })
    await Promise.all(writeToDiskJobs)
}

function getPackageArchivePathForQadam(rootWorkspace: string, qadamPackage: PrivateQadamPackage): string {
    return join(qadamPath(rootWorkspace, qadamPackage), `${qadamPackage.archiveId}.tgz`)
}

type InstallParams = {
    pieces: QadamPackage[]
    includeFilters: boolean
}

type QadamInstallationResult = {
    qadamsToInstall: QadamPackage[]
}
