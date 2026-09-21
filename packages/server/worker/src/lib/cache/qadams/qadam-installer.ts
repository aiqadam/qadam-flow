import { readFile, rm, writeFile } from 'node:fs/promises'
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
    unique,
    WorkerToApiContract,
} from '@aiqadam/shared'
import { Span, trace } from '@opentelemetry/api'
import { Logger } from 'pino'
import writeFileAtomic from 'write-file-atomic'
import { workerSettings } from '../../config/worker-settings'
import { getGlobalCacheCommonPath, getGlobalCachePathLatestVersion } from '../cache-paths'
import { bunRunner } from '../code/bun-runner'
import { qadamIntegrity } from './qadam-integrity'

const tracer = trace.getTracer('qadam-installer')

const usedQadamsMemoryCache: Record<string, boolean> = {}
// The workspaces glob in createInstallWorkspaceFiles has to address this same directory. When the
// two drifted apart (the glob still said `pieces/**` after the rename), bun matched no workspace,
// exited 0 with "No packages!", and created no node_modules — so qadamCheckIfAlreadyInstalled
// deleted the `ready` marker and every job reinstalled from scratch, forever.
const QADAMS_DIR = 'qadams'
// Read and restored by name here rather than imported from qadam-integrity: this module owns
// the workspace's files, that one owns their interpretation.
const LOCKFILE_NAME = 'bun.lock'

// #482 items 2 and 3. Both exist because bun reads `.npmrc` and `bunfig.toml` from the install
// WORKING DIRECTORY and from `$HOME`, and does not walk up the tree — so neither of the repo-root
// copies reaches this workspace (`cache/v12/common`, see getGlobalCacheCommonPath). Writing them
// here, next to the root package.json, is the only way either one is in force where packages are
// actually installed.
const OFFICIAL_QADAM_SCOPE = '@aiqadam'
// A literal rather than an operator knob: making the registry configurable is #478, and it has to
// validate an admin-supplied URL that `safeHttp` structurally cannot cover (bun performs the fetch
// in a subprocess, so the request-filtering agent never sees it). Pinning it to a literal is what
// closes #482 item 2 on its own — with the scope named here, resolution for `@aiqadam/*` cannot
// silently follow a default `registry=` set by a stray `$HOME/.npmrc` or by an internal mirror.
// #478 replaces the literal; it does not remove the pin.
//
// Two things it deliberately does NOT do. It pins the SCOPE, not the graph: every third-party
// transitive dependency of an official qadam — axios, tslib, the AWS SDKs — loads into the same
// engine process and still resolves through bun's default registry. Closing that would mean
// writing a default `registry=` line too, which would forbid operators from mirroring at all, so
// it belongs in #478's design rather than here. And it is not a defence against a proxy that
// intercepts the URL named below; what defends an `https://` registry against interception is
// TLS trust, not the scope mapping.
const OFFICIAL_QADAM_REGISTRY_URL = 'https://registry.npmjs.org/'
// The same three days the repo-root bunfig.toml applies to this repo's own installs.
const INSTALL_QUARANTINE_SECONDS = 259_200
// Conservative npm package-name shape. Names reaching the excludes list below come from the
// database (an administrator typed them when registering a custom qadam) and are interpolated
// into a TOML array, so anything that is not plainly a package name is dropped rather than
// written. Dropping fails safe: the name stays quarantined, and a name this rejects could not
// have been installed from a registry anyway.
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
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

            await createInstallWorkspaceFiles({
                path: rootWorkspace,
                qadamsToInstall,
            })

            await savePackageArchivesToDiskIfNotCached(rootWorkspace, qadamsToInstall, apiClient)

            await Promise.all(qadamsToInstall.map(piece => createQadamPackageJson({
                rootWorkspace,
                qadamPackage: piece,
            })))

            const before = await readWorkspaceBeforeInstall({ rootWorkspace, log })

            await tracer.startActiveSpan('qadamInstaller.bunInstall', async (span) => {
                try {
                    span.setAttribute('qadams.count', qadamsToInstall.length)
                    span.setAttribute('qadams.rootWorkspace', rootWorkspace)

                    const { error: batchError } = await tryCatch(async () => bunRunner(log).install({
                        path: rootWorkspace,
                        filtersPath: includeFilters ? qadamsToInstall.map(relativeQadamPath) : [],
                    }))

                    if (isNil(batchError)) {
                        await verifyIntegrityThenMarkAsUsed({ rootWorkspace, installed: qadamsToInstall, before, span, log })
                        log.info({
                            rootWorkspace,
                            qadamsCount: qadamsToInstall.length,
                        }, '[qadamInstaller] Installed registry qadams using bun')
                        return
                    }

                    span.recordException(batchError instanceof Error ? batchError : new Error(String(batchError)))

                    if (qadamsToInstall.length === 1) {
                        log.error({ rootWorkspace, error: batchError }, '[qadamInstaller] Qadam installation failed, rolling back')
                        await rollbackInstallation({ rootWorkspace, pieces: qadamsToInstall, before })
                        throw batchError
                    }

                    log.warn({
                        rootWorkspace,
                        pieces: qadamsToInstall.map(piece => `${piece.qadamName}-${piece.qadamVersion}`),
                        error: batchError,
                    }, '[qadamInstaller] Batch install failed, retrying qadams individually')

                    const failedQadams = await tryInstallQadamsIndividually(rootWorkspace, qadamsToInstall, log)

                    // Verification happens here rather than per iteration, and the survivors are
                    // marked usable only once it has passed. Per iteration was wrong twice over:
                    // bun resolves every workspace member regardless of `--filter`, so each
                    // iteration re-read the same whole-workspace lockfile and blamed whichever
                    // qadam happened to be in hand rather than the offending entry; and marking
                    // inside the loop recorded a qadam usable before anything had checked what
                    // came down with it. A failure here still fails the whole surviving batch —
                    // that part is unchanged, and deliberate — but it now names the real
                    // offender, and does it once.
                    const installed = qadamsToInstall.filter((piece) => !failedQadams.includes(piece))
                    if (installed.length > 0) {
                        await verifyIntegrityThenMarkAsUsed({ rootWorkspace, installed, before, span, log })
                    }

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
// #482 is closed. What follows is the state as of step 1a landing; read it as a status board
// rather than as a standing description, because two of the three facts it used to state have
// changed and the third has not.
//
// The `@aiqadam` npm scope IS OURS — claimed, and now occupied: `@aiqadam/shared`,
// `@aiqadam/qadams-framework` and `@aiqadam/qadams-common` are published (#475), and #476 puts the
// 238 qadams under it. An earlier version of this comment told the reader the scope was unclaimed
// and that every `@aiqadam/*` name therefore 404s, which was the benign-but-true reading at the
// time and is simply wrong now — an operator who flips the flag "to watch it 404" would instead
// get a real resolution against real packages. The dependency-confusion squat that framing warned
// about is closed: nobody else can publish these names.
//
// What the flag still routes, and why the remaining preconditions matter. With it on, the ENTIRE
// official catalogue is resolved from a registry rather than from the image — the names are not
// chosen by any administrator, they are the whole catalogue. `createQadamPackageJson` writes each
// one straight into a package.json dependency and `bunRunner.install` fetches it. It lands in the
// SHARED workspace (`getGlobalCacheCommonPath()`, not a per-platform path — see
// `groupQadamsByPackagePath`), the engine prefers an installed directory over the bundled `dist`
// build, and whatever resolved then executes for every tenant on that worker.
//
// One mitigation that looks like it would cover that and does not, recorded so nobody re-derives
// and re-rejects it: `bun install --ignore-scripts` (`bun-runner.ts`) blocks `postinstall`, but
// the qadam is `require`d by the engine rather than run via a lifecycle script, so lifecycle
// scripts are not the vector.
//
// Two mitigations that DO apply are now in force, written by `createInstallWorkspaceFiles` into
// the directory bun actually installs in: the `@aiqadam:registry` pin (#482 item 2), so
// resolution for the scope cannot fall back to a mirror, proxy or stray `$HOME/.npmrc`; and the
// `minimumReleaseAge` quarantine (#482 item 3), which the repo-root `bunfig.toml` never reached
// because bun does not walk up the tree. #482 item 4 (integrity pinning for the official set) is
// still open, and `--frozen-lockfile` is not the answer to it — this workspace has no
// checked-in lockfile to freeze and gains qadams incrementally, so freezing it would fail every
// install that adds one. See #482 before flipping anything.
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

// `before` is optional because the two rollbacks want different things. A rollback that ABANDONS
// the install (a fatal batch error, a failed integrity pass) passes it, so the lockfile goes back
// to what it was and this attempt leaves no trace for the next one to misread. The per-piece
// rollback inside the individual-fallback loop does not: later iterations legitimately extend the
// lockfile, and restoring mid-loop would discard the entries of the qadams that just succeeded.
// That loop is still covered — the integrity pass runs once over whatever bun finally wrote, and
// if it throws, the abandoning rollback above it restores the snapshot.
async function rollbackInstallation({ rootWorkspace, pieces, before }: {
    rootWorkspace: string
    pieces: QadamPackage[]
    before?: WorkspaceBeforeInstall
}): Promise<void> {
    await Promise.all(pieces.map(piece => rm(path.resolve(rootWorkspace, relativeQadamPath(piece)), {
        recursive: true,
        force: true,
    })))
    if (!isNil(before)) {
        await restoreLockfile({ rootWorkspace, before })
    }
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
            await rollbackInstallation({ rootWorkspace, pieces: [piece] })
            failures.push(piece)
        }
    }
    // The survivors are NOT marked usable here — the caller does that, after one integrity pass
    // over the whole workspace. Marking a qadam usable is the thing that makes the next install
    // skip it entirely, so it must not happen before whatever came down with it has been checked.
    return failures
}

// #482 item 4's wiring, and the ordering is the point: verify, then mark. `markQadamsAsUsed`
// writes the `ready` marker that makes every later install short-circuit, so a batch recorded as
// usable is a batch nothing will ever look at again.
//
// Gated on OFFICIAL_QADAMS_INSTALL_ENABLED because the check exists for the feature that flag
// guards. With the flag off no official qadam is installed at all, and running the check anyway
// would put a new hard dependency on registry reachability FROM THIS PROCESS onto the default
// custom-qadam path: every qadam built against this framework pins `@aiqadam/shared`,
// `@aiqadam/qadams-framework` and `@aiqadam/qadams-common`, so those three land in the lockfile of
// a plain custom install too, and verifying them fail-closed would turn a brief registry outage
// into a failed install where today there is none. The flag is also the documented escape hatch
// for an npmjs key rotation, which only means anything if it gates this.
async function verifyIntegrityThenMarkAsUsed({ rootWorkspace, installed, before, span, log }: {
    rootWorkspace: string
    installed: QadamPackage[]
    before: WorkspaceBeforeInstall
    span: Span
    log: Logger
}): Promise<void> {
    if (workerSettings.getSettings().OFFICIAL_QADAMS_INSTALL_ENABLED) {
        const { error } = await tryCatch(async () =>
            qadamIntegrity(log).verifyOfficialQadams({
                rootWorkspace,
                installed,
                refusedBeforeInstall: before.refusedKeys,
            }),
        )
        if (!isNil(error)) {
            span.recordException(error instanceof Error ? error : new Error(String(error)))
            log.error({ rootWorkspace, error }, '[qadamInstaller] Integrity verification failed, rolling back')
            await rollbackInstallation({ rootWorkspace, pieces: installed, before })
            throw error
        }
    }
    await markQadamsAsUsed(rootWorkspace, installed)
}

// Everything about the workspace that a rollback has to be able to put back. Captured immediately
// before `bun install`, inside the same file lock.
//
// `lockfileContents` is the reason this is a snapshot rather than just the key set. `bun install`
// REWRITES `bun.lock` before the integrity pass ever reads it, and the old rollback removed only
// the qadam directories — so a pass that failed closed left its own refused entry in the shared
// lockfile, and the NEXT pass read that as "already refused before this install" and let the same
// entry through. Both reviewers found it independently: the gate held for exactly one attempt, and
// the batch is reinstalled on the next job because no `ready` marker was written. Restoring the
// bytes means a rejected install authors no part of its successor's pre-image, so every retry
// re-derives the same fail-closed answer.
//
// Restoring rather than deleting: the lockfile is the whole shared workspace's, so deleting it to
// undo one batch would discard every other tenant's resolution and force a full re-resolve.
//
// What this deliberately does NOT restore is `node_modules` — nothing prunes the refused bytes
// from the tree. The guarantee is "a refused batch is never marked usable and never launders its
// own output into the next attempt", not "the tree is clean".
async function readWorkspaceBeforeInstall({ rootWorkspace, log }: {
    rootWorkspace: string
    log: Logger
}): Promise<WorkspaceBeforeInstall> {
    // Off the flag as well as the verification itself: with the flag off nothing verifies and
    // nothing rolls back on integrity grounds, so this would be a read bought for nothing on
    // every custom-qadam install.
    if (!workerSettings.getSettings().OFFICIAL_QADAMS_INSTALL_ENABLED) {
        return { lockfileContents: undefined, refusedKeys: new Set() }
    }
    const { data } = await tryCatch(async () =>
        readFile(join(rootWorkspace, LOCKFILE_NAME), 'utf8'))
    // `tryCatch` reports "no value" as null; the rest of this path reads absence as undefined.
    const lockfileContents = data ?? undefined
    return {
        lockfileContents,
        // Classified from the SAME bytes that were snapshotted, not from a second read — otherwise
        // the set restored and the set reasoned about could not be shown to be the same file.
        refusedKeys: qadamIntegrity(log).refusedKeysIn({ lockfileContents }),
    }
}

async function restoreLockfile({ rootWorkspace, before }: {
    rootWorkspace: string
    before: WorkspaceBeforeInstall
}): Promise<void> {
    const lockfilePath = join(rootWorkspace, LOCKFILE_NAME)
    if (isNil(before.lockfileContents)) {
        // There was no lockfile before, and a missing one is already the conservative
        // "nothing was refused before" reading the next pass needs.
        await rm(lockfilePath, { force: true })
        return
    }
    await writeFileAtomic(lockfilePath, before.lockfileContents, 'utf8')
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

async function createInstallWorkspaceFiles({ path, qadamsToInstall }: {
    path: string
    qadamsToInstall: QadamPackage[]
}): Promise<void> {
    const packageJsonPath = join(path, 'package.json')
    await fileSystemUtils.threadSafeMkdir(dirname(packageJsonPath))
    await Promise.all([
        writeFileAtomic(packageJsonPath, JSON.stringify({
            'name': 'fast-workspace',
            'version': '1.0.0',
            'workspaces': [
                `${QADAMS_DIR}/**`,
            ],
        }, null, 2), 'utf8'),
        writeFileAtomic(join(path, '.npmrc'), `${OFFICIAL_QADAM_SCOPE}:registry=${OFFICIAL_QADAM_REGISTRY_URL}\n`, 'utf8'),
        writeFileAtomic(join(path, 'bunfig.toml'), buildInstallBunfig(qadamsToInstall), 'utf8'),
    ])
}

// Three measured properties of bun 1.3 shape this, and none of them is obvious from the docs:
//
//   * `minimumReleaseAge` does not DOWNGRADE an exact pin, it fails the install outright
//     ("No version matching … blocked by minimum-release-age"). The dependency
//     `createQadamPackageJson` writes is always an exact version, so for the qadam itself the
//     quarantine is a hard refusal rather than a downgrade. Its transitive dependencies are
//     whatever the published tarball declares, and a third-party qadam may well declare ranges —
//     there a fresh release is skipped over instead, which is the quieter of the two outcomes.
//   * `minimumReleaseAgeExcludes` is NOT transitive. Exempting a package exempts that name only;
//     its own freshly published dependencies stay blocked. So the exemption below rescues the
//     common case (an administrator installing a custom qadam they just published) and not the
//     case where that qadam also pins a dependency released in the last three days.
//   * an unrecognised key in `[install]` is silently ignored — no warning, no error. A typo in
//     either key name therefore reads as a fully-armed quarantine with no exemptions, which is
//     the fail-safe direction but is invisible. Do not rename these without re-probing bun.
//
// The exemption is drawn exactly where #482 draws the line it cares about: "these names are not
// admin-chosen, so there is no human in the loop to notice a substitution". A CUSTOM REGISTRY
// qadam is the opposite case — an administrator typed that package name deliberately — and
// blocking it for three days would break iterating on a private qadam, a workflow that works
// today. The official catalogue gets no exemption, which is the entire point of item 3.
//
// The exemption is narrower than "every custom qadam", in two ways worth knowing before someone
// widens it. An ARCHIVE qadam gets none, because it installs from a tarball on disk and the
// quarantine has nothing to say about it — but its third-party dependencies still resolve from
// the registry and are still quarantined. And because the excludes are not transitive, a custom
// qadam that pins a dependency released in the last three days still fails to install, exempt
// name or not. Both are behaviour changes against today; neither has a fix at this layer.
//
// `[install]` carries the quarantine keys and NOTHING else. The repo-root bunfig.toml also sets
// `linker = "isolated"`, and an earlier version of this comment claimed copying it here would
// change the node_modules layout the engine's loader walks. Measured against bun 1.3.11 (newer than the 1.3.1 the image pins), that is
// wrong: the default is hoisted for a plain project but ISOLATED for a workspace, and the root
// package.json written above declares `workspaces`, so this layout is already isolated and the
// key would be a no-op. Leaving it out is still right — an inherited default that matches is not
// a reason to restate it — but do not re-add it believing it changes anything.
function buildInstallBunfig(qadamsToInstall: QadamPackage[]): string {
    const adminChosenNames = unique(
        qadamsToInstall
            .filter((piece) => piece.packageType === PackageType.REGISTRY && piece.qadamType === QadamType.CUSTOM)
            .map((piece) => piece.qadamName)
            .filter((qadamName) => NPM_PACKAGE_NAME_PATTERN.test(qadamName))
            // The exemption is decided by `qadamType`, but what lands in the file is a NAME, and
            // nothing stops a CUSTOM qadam from being registered under an official one:
            // `qadamMetadataService.create` applies no name validation and scopes uniqueness by
            // platformId, so a platform can register `@aiqadam/qadam-slack` of its own. In the
            // default UNSANDBOXED mode that qadam installs into this same shared workspace, so
            // without this filter one platform's naming choice would lift the quarantine off an
            // official name for every tenant on the worker. Filter on the name, because the name
            // is what the quarantine keys on.
            .filter((qadamName) => !qadamName.startsWith(`${OFFICIAL_QADAM_SCOPE}/`)),
    )
    const excludes = adminChosenNames.map((qadamName) => `"${qadamName}"`).join(', ')
    return [
        '[install]',
        `minimumReleaseAge = ${INSTALL_QUARANTINE_SECONDS}`,
        `minimumReleaseAgeExcludes = [${excludes}]`,
        '',
    ].join('\n')
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

// The workspace state a rollback may have to put back — see `readWorkspaceBeforeInstall`.
// `lockfileContents` is undefined when there was no lockfile at all, which is both the
// first-install case and the state a rollback restores to.
type WorkspaceBeforeInstall = {
    lockfileContents: string | undefined
    refusedKeys: Set<string>
}

type InstallParams = {
    pieces: QadamPackage[]
    includeFilters: boolean
}

type QadamInstallationResult = {
    qadamsToInstall: QadamPackage[]
}
