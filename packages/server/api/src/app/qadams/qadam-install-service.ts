import { QadamMetadata, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    AddQadamRequestBody,
    EngineResponse,
    EngineResponseStatus,
    ErrorCode,
    ExecuteExtractQadamMetadata,
    FileCompression,
    FileId,
    FileType,
    isNil,
    isOfficialQadamName,
    PackageType,
    PlatformId,
    ProjectId,
    QadamFlowError,
    QadamPackage,
    QadamType,
    WorkerJobType,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { fileService } from '../file/file.service'
import { userInteractionWatcher } from '../workers/user-interaction-watcher'
import { qadamMetadataService } from './metadata/qadam-metadata-service'

export const qadamInstallService = (log: FastifyBaseLogger) => ({
    async installQadam(
        platformId: string,
        params: AddQadamRequestBody,
    ): Promise<QadamMetadataModel> {
        // #503, before anything is written or run: `saveQadamPackage` persists the archive and
        // `extractQadamInformation` has the worker install the package into the workspace every
        // tenant shares and execute it to read its metadata. Refusing only in
        // `qadamMetadataService.create` (kept, as defence in depth) would leave that installed
        // directory behind after the row is rejected. The engine echoes `qadamName` back as the
        // metadata name, so the string checked here is the one the row would have carried.
        if (isOfficialQadamName(params.qadamName)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `qadam_name_reserved_for_official_qadams name=${params.qadamName}`,
                },
            })
        }
        try {
            const qadamPackage = await saveQadamPackage(platformId, params, log)
            const qadamInformation = await extractQadamInformation({
                ...qadamPackage,
                platformId,
            }, log)
            const archiveId = qadamPackage.packageType === PackageType.ARCHIVE ? qadamPackage.archiveId : undefined
            const savedQadam = await qadamMetadataService(log).create({
                qadamMetadata: {
                    ...qadamInformation,
                    minimumSupportedRelease:
                        qadamInformation.minimumSupportedRelease ?? '0.0.0',
                    maximumSupportedRelease:
                        qadamInformation.maximumSupportedRelease ?? '999.999.999',
                    name: qadamInformation.name,
                    version: qadamInformation.version,
                    i18n: qadamInformation.i18n,
                },
                packageType: params.packageType,
                platformId,
                qadamType: QadamType.CUSTOM,
                archiveId,
            })
            return savedQadam
        }
        catch (error) {
            log.error({ err: error }, '[qadamInstallService#add] Failed to add qadam')

            if (error instanceof QadamFlowError && error.error.code === ErrorCode.VALIDATION) {
                throw error
            }
            throw new QadamFlowError({
                code: ErrorCode.ENGINE_OPERATION_FAILURE,
                params: {
                    message: JSON.stringify(error),
                },
            })
        }
    },
})


async function saveQadamPackage(platformId: string | undefined, params: AddQadamRequestBody, log: FastifyBaseLogger): Promise<QadamPackage> {

    switch (params.packageType) {
        case PackageType.ARCHIVE: {
            const archiveId = await saveArchive({
                projectId: undefined,
                platformId,
                archive: params.qadamArchive.data as Buffer,
            }, log)
            return {
                ...params,
                qadamType: QadamType.CUSTOM,
                archiveId,
                platformId: platformId!,
                packageType: params.packageType,
            }
        }

        case PackageType.REGISTRY: {
            return {
                ...params,
                qadamType: QadamType.CUSTOM,
                platformId: platformId!,
            }
        }
    }
}

const extractQadamInformation = async (request: ExecuteExtractQadamMetadata, log: FastifyBaseLogger): Promise<QadamMetadata> => {
    const engineResponse = await userInteractionWatcher.submitAndWaitForResponse<EngineResponse<QadamMetadata>>({
        jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
        platformId: request.platformId,
        qadam: request,
        projectId: undefined,
    }, log)

    if (engineResponse.status !== EngineResponseStatus.OK) {
        throw new Error(engineResponse.error)
    }
    return engineResponse.response
}

const saveArchive = async (
    params: GetQadamArchivePackageParams,
    log: FastifyBaseLogger,
): Promise<FileId> => {
    const { projectId, platformId, archive } = params

    const archiveFile = await fileService(log).save({
        projectId: isNil(platformId) ? projectId : undefined,
        platformId,
        data: archive,
        size: archive.length,
        type: FileType.PACKAGE_ARCHIVE,
        compression: FileCompression.NONE,
    })

    return archiveFile.id
}

type GetQadamArchivePackageParams = {
    archive: Buffer
    projectId?: ProjectId
    platformId?: PlatformId
}

