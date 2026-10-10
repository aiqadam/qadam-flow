import path from 'path'
import { NPM_PACKAGE_NAME_MAX_LENGTH } from '@aiqadam/server-utils'
import { ApEnvironment, NPM_PACKAGE_NAME_REGEX, PackageType, QadamPackage, QadamType, qadamVersionParser, WorkerToApiContract } from '@aiqadam/shared'
import { trace } from '@opentelemetry/api'
import { Logger } from 'pino'
import { workerSettings } from '../../config/worker-settings'
import { getGlobalCacheQadamsPath } from '../cache-paths'
import { cacheState, NO_SAVE_GUARD } from '../cache-state'

// One path segment is at most 255 bytes on the filesystems a worker runs on; a margin is left for
// what is appended to a cache folder's name (the `.cache-state` lock suffix).
const MAX_CACHE_SEGMENT_BYTES = 240

const tracer = trace.getTracer('qadam-cache')

export const qadamCache = (log: Logger, apiClient: WorkerToApiContract) => ({
    async getPiece({ qadamName, qadamVersion, platformId }: PieceCacheKey): Promise<QadamPackage> {
        // The cache folder below is named after the qadam. The API refuses names outside the npm
        // package-name grammar and the installer will not install one, so such a name is answered
        // as not found before any path is built from it.
        if (qadamName.length > NPM_PACKAGE_NAME_MAX_LENGTH || !NPM_PACKAGE_NAME_REGEX.test(qadamName)) {
            throw new PieceNotFoundError(qadamName, qadamVersion)
        }
        // A pin that is no version at all ('latest', '', '1.0', a range with trailing text) is
        // answered as not found here, like a malformed name: the API would throw a plain Error on
        // it, which provisioning rethrows, and ON_DISABLE and every tick would fail on it (#432).
        // Agent tools carry their version unvalidated, so they can reach this (#779).
        if (qadamVersionParser.parsePin({ pin: qadamVersion }) === null) {
            throw new PieceNotFoundError(qadamName, qadamVersion)
        }
        const isExactVersion = qadamVersionParser.isExact({ version: qadamVersion })

        if (!isExactVersion) {
            return getQadamPackage({ qadamName, qadamVersion, platformId }, apiClient)
        }

        const cacheKey = `${qadamName}-${qadamVersion}-${platformId}`
        // A name inside npm's 214 characters is not enough: the folder is `<name>-<version>-<platform>`,
        // and a long name with a long exact version (`x.y.z-main.<n>` is up to 44 characters) is one
        // segment past what the filesystem accepts. readCacheFromFile rethrows ENAMETOOLONG as a
        // plain Error, which provisioning rethrows, and ON_DISABLE would fail (#432). Such a pin is
        // not cached: it asks the API each time, like a range does. Read and write share this one key.
        if (hasSegmentTooLongForDisk({ cacheKey })) {
            return getQadamPackage({ qadamName, qadamVersion, platformId }, apiClient)
        }
        const cache = cacheState(path.join(getGlobalCacheQadamsPath(), cacheKey))

        const { state } = await cache.getOrSetCache({
            key: cacheKey,
            cacheMiss: (_: string) => {
                const environment = workerSettings.getSettings().ENVIRONMENT
                if (environment === ApEnvironment.TESTING) {
                    return true
                }
                const devQadams = workerSettings.getSettings().DEV_QADAMS
                if (devQadams.includes(qadamName)) {
                    return true
                }
                return false
            },
            installFn: async () => {
                return tracer.startActiveSpan('qadamCache.fetchPiece', async (span) => {
                    try {
                        span.setAttribute('piece.name', qadamName)
                        span.setAttribute('piece.version', qadamVersion)
                        const qadamPackage = await getQadamPackage({ qadamName, qadamVersion, platformId }, apiClient)
                        log.info({ qadamName, qadamVersion, platformId }, 'Cached piece')
                        return JSON.stringify(qadamPackage)
                    }
                    finally {
                        span.end()
                    }
                })
            },
            skipSave: NO_SAVE_GUARD,
        })

        return JSON.parse(state as string) as QadamPackage
    },
})

// `/` splits a scoped name into its scope folder and the rest: each is a segment of its own.
function hasSegmentTooLongForDisk({ cacheKey }: { cacheKey: string }): boolean {
    return cacheKey.split('/').some((segment) => Buffer.byteLength(segment) > MAX_CACHE_SEGMENT_BYTES)
}

async function getQadamPackage(query: PieceCacheKey, apiClient: WorkerToApiContract): Promise<QadamPackage> {
    const qadamMetadata = await apiClient.getQadam({
        name: query.qadamName,
        version: query.qadamVersion,
        platformId: query.platformId,
    }) as { packageType: PackageType, name: string, version: string, qadamType: QadamType, archiveId?: string } | null

    if (!qadamMetadata) {
        throw new PieceNotFoundError(query.qadamName, query.qadamVersion)
    }

    const baseProps = {
        packageType: qadamMetadata.packageType,
        qadamName: qadamMetadata.name,
        qadamVersion: qadamMetadata.version,
        qadamType: qadamMetadata.qadamType,
    }

    if (qadamMetadata.packageType === PackageType.ARCHIVE) {
        return {
            ...baseProps,
            archiveId: qadamMetadata.archiveId!,
            platformId: query.platformId,
        } as QadamPackage
    }

    if (qadamMetadata.qadamType === QadamType.CUSTOM) {
        return {
            ...baseProps,
            platformId: query.platformId,
        } as QadamPackage
    }

    return baseProps as QadamPackage
}

export class PieceNotFoundError extends Error {
    // `usedBy` is what pins it, when the caller knows: `the step step_2` or `an agent tool of step step_3`.
    // Built from step names only (they are checked), never from flow-authored free text such as a
    // tool name, because it reaches an error an MCP client reads (#779).
    public readonly usedBy: string | undefined

    constructor(public readonly qadamName: string, public readonly qadamVersion: string, options?: { usedBy?: string }) {
        super(`Piece metadata not found for ${qadamName}@${qadamVersion}`)
        this.name = 'PieceNotFoundError'
        this.usedBy = options?.usedBy
    }
}

type PieceCacheKey = {
    qadamName: string
    qadamVersion: string
    platformId: string
}
