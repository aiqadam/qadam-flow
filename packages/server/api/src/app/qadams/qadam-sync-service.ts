import { QadamMetadata } from '@aiqadam/qadams-framework'
import { apVersionUtil } from '@aiqadam/server-utils'
import { groupBy, PackageType, QadamSyncMode, QadamType, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import semver from 'semver'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { SystemJobName } from '../helper/system-jobs/common'
import { systemJobHandlers } from '../helper/system-jobs/job-handlers'
import { systemJobsSchedule } from '../helper/system-jobs/system-job'
import { qadamCache } from './metadata/qadam-cache'
import { QadamMetadataSchema } from './metadata/qadam-metadata-entity'
import { qadamMetadataService, qadamRepos } from './metadata/qadam-metadata-service'

const CLOUD_API_URL = 'https://flow.aiqadam.org/api/v1/pieces'
const syncMode = system.get<QadamSyncMode>(AppSystemProp.QADAMS_SYNC_MODE)

export const qadamSyncService = (log: FastifyBaseLogger) => ({
    async setup(): Promise<void> {
        systemJobHandlers.registerJobHandler(SystemJobName.PIECES_SYNC, async function syncPiecesJobHandler(): Promise<void> {
            await qadamSyncService(log).sync({ publishCacheRefresh: true })
        })
        rejectedPromiseHandler(qadamSyncService(log).sync({ publishCacheRefresh: false }), log)
        await systemJobsSchedule(log).upsertJob({
            job: {
                name: SystemJobName.PIECES_SYNC,
                data: {},
                jobId: SystemJobName.PIECES_SYNC,
            },
            schedule: {
                type: 'repeated',
                cron: `${Math.floor(Math.random() * 5)} */1 * * *`,
            },
        })
    },
    async sync({ publishCacheRefresh }: { publishCacheRefresh: boolean }): Promise<void> {
        if (syncMode !== QadamSyncMode.OFFICIAL_AUTO) {
            log.info('Piece sync service is disabled')
            return
        }
        try {
            log.info('Starting piece synchronization')
            const startTime = performance.now()
            const [dbPieces, cloudPieces] = await Promise.all([qadamRepos().find({
                select: {
                    name: true,
                    version: true,
                    qadamType: true,
                },
            }), listCloudPieces()])
            log.info({ dbCount: dbPieces.length, cloudCount: cloudPieces.length }, 'Fetched pieces from DB and Cloud')
            const added = await installNewPieces(cloudPieces, dbPieces, log, publishCacheRefresh)
            const deleted = await deletePiecesIfNotOnCloud(dbPieces, cloudPieces, log)

            log.info({
                added,
                deleted,
                durationMs: Math.floor(performance.now() - startTime),
            }, 'Piece synchronization completed')
        }
        catch (error) {
            log.error({ error }, 'Error syncing pieces')
        }
    },
})

async function deletePiecesIfNotOnCloud(dbPieces: QadamMetadataOnly[], cloudPieces: PieceRegistryResponse[], log: FastifyBaseLogger): Promise<number> {
    const cloudMap = new Map<string, true>(cloudPieces.map(cloudPiece => [`${cloudPiece.name}:${cloudPiece.version}`, true]))
    const piecesToDelete = dbPieces.filter(piece => piece.qadamType === QadamType.OFFICIAL && !cloudMap.has(`${piece.name}:${piece.version}`))
    await qadamMetadataService(log).bulkDelete(piecesToDelete.map(piece => ({ name: piece.name, version: piece.version })))
    return piecesToDelete.length
}

async function installNewPieces(cloudPieces: PieceRegistryResponse[], dbPieces: QadamMetadataOnly[], log: FastifyBaseLogger, _publishCacheRefresh: boolean): Promise<number> {
    const dbMap = new Map<string, true>(dbPieces.map(dbPiece => [`${dbPiece.name}:${dbPiece.version}`, true]))
    const newPiecesToFetch = cloudPieces.filter(piece => !dbMap.has(`${piece.name}:${piece.version}`))
    const batchSize = 5
    for (let done = 0; done < newPiecesToFetch.length; done += batchSize) {
        const currentBatch = newPiecesToFetch.slice(done, done + batchSize)
        await Promise.all(currentBatch.map(async (piece) => {
            const url = `${CLOUD_API_URL}/${piece.name}${piece.version ? '?version=' + piece.version : ''}`
            const response = await fetch(url)
            if (!response.ok) {
                log.warn({ qadamName: piece.name, version: piece.version, status: response.status }, '[qadamSyncService#installNewPieces] Error reading piece metadata')
                return
            }
            const qadamMetadata = await response.json() as QadamMetadata & { packageType: PackageType, qadamType: QadamType }
            const { error } = await tryCatch(() => qadamMetadataService(log).create({
                qadamMetadata,
                packageType: qadamMetadata.packageType,
                qadamType: qadamMetadata.qadamType,
                publishCacheRefresh: false,
            }))
            if (error) {
                log.debug({ qadamName: piece.name, version: piece.version }, '[qadamSyncService#installNewPieces] Piece already exists, skipping')
            }
        }))
    }
    if (newPiecesToFetch.length > 0) {
        await qadamCache(log).invalidate()
    }
    return newPiecesToFetch.length
}


async function listCloudPieces(): Promise<PieceRegistryResponse[]> {
    const queryParams = new URLSearchParams()
    queryParams.append('edition', 'ce')
    queryParams.append('release', apVersionUtil.getCurrentRelease())
    const response = await fetch(`${CLOUD_API_URL}/registry?${queryParams.toString()}`)
    if (!response.ok) {
        throw new Error(`Failed to fetch cloud pieces: ${response.status}`)
    }
    const pieces = await response.json() as PieceRegistryResponse[]
    const piecesByName = groupBy(pieces, p => p.name)
    const latest = []
    const others = []

    for (const group of Object.values(piecesByName)) {
        const sortedByVersion = sortByVersionDesc(group)
        latest.push(sortedByVersion[0])
        others.push(...sortedByVersion.slice(1))
    }

    return [...latest, ...others]
}

function sortByVersionDesc(items: PieceRegistryResponse[]) {
    return [...items].sort((a, b) =>
        semver.rcompare(a.version, b.version),
    )
}

type PieceRegistryResponse = {
    name: string
    version: string
}


type QadamMetadataOnly = Pick<QadamMetadataSchema, 'name' | 'version' | 'qadamType'>
