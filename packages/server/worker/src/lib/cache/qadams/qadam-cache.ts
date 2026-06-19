import path from 'path'
import { ApEnvironment, EXACT_VERSION_REGEX, PackageType, QadamPackage, QadamType, WorkerToApiContract } from '@aiqadam/shared'
import { trace } from '@opentelemetry/api'
import { Logger } from 'pino'
import { workerSettings } from '../../config/worker-settings'
import { getGlobalCacheQadamsPath } from '../cache-paths'
import { cacheState, NO_SAVE_GUARD } from '../cache-state'

const tracer = trace.getTracer('qadam-cache')

export const qadamCache = (log: Logger, apiClient: WorkerToApiContract) => ({
    async getPiece({ qadamName, qadamVersion, platformId }: PieceCacheKey): Promise<QadamPackage> {
        const isExactVersion = EXACT_VERSION_REGEX.test(qadamVersion)

        if (!isExactVersion) {
            return getQadamPackage({ qadamName, qadamVersion, platformId }, apiClient)
        }

        const cacheKey = `${qadamName}-${qadamVersion}-${platformId}`
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
    constructor(qadamName: string, qadamVersion: string) {
        super(`Piece metadata not found for ${qadamName}@${qadamVersion}`)
        this.name = 'PieceNotFoundError'
    }
}

type PieceCacheKey = {
    qadamName: string
    qadamVersion: string
    platformId: string
}
