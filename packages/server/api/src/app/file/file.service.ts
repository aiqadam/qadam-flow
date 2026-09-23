import {
    apId,
    assertNotNullOrUndefined,
    ErrorCode,
    File,
    FileCompression,
    FileId,
    FileLocation,
    FileType,
    isMultipartFile,
    isNil,
    ProjectId,
    QadamFlowError,
} from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { In, IsNull, LessThanOrEqual } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { exceptionHandler } from '../helper/exception-handler'
import { JwtAudience, jwtUtils } from '../helper/jwt-utils'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { fileCompressor } from './file-compressor'
import { FileEntity } from './file.entity'
import { s3Helper } from './s3-helper'

const ALLOWED_SIGNED_FILE_TYPES: FileType[] = [FileType.FLOW_STEP_FILE, FileType.FLOW_RUN_LOG_SLICE]

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'image/bmp', 'image/ico', 'image/avif', 'image/apng']

export const fileRepo = repoFactory<File>(FileEntity)
const EXECUTION_DATA_RETENTION_DAYS = system.getNumberOrThrow(AppSystemProp.EXECUTION_DATA_RETENTION_DAYS)

type BaseFile = Pick<File, 'id' | 'projectId' | 'platformId' | 'type' | 'fileName' | 'compression' | 'size' | 'metadata' | 'created' | 'updated'>

type UpsertOwnedFileParams = {
    baseFile: BaseFile
    location: FileLocation
    data: Buffer | null
    s3Key: string | null
}

// A caller (e.g. the engine, via PUT /v1/files/:fileId) picks the id, and TypeORM's
// `.save()` upserts on that primary key with no ownership check — an engine token for
// project A could overwrite a file row owned by project B just by guessing/learning its
// id (#517). This is a single INSERT ... ON CONFLICT DO UPDATE ... WHERE statement so the
// ownership check and the write are atomic: two API replicas racing on the same id cannot
// both pass a separate "does it exist" check and then both write, because Postgres
// evaluates the WHERE against the row as it stands inside this one statement.
//
// Ownership: a project-owned row (projectId not null) is matched by projectId ALONE —
// several current callers (sample-data.service.ts, trigger-event.service.ts) never pass
// platformId at all, so a NULL platformId already on the row must never block its own
// project from re-saving it; COALESCE backfills platformId from the caller once it's
// available, rather than requiring it to already match. A platform-level row (projectId
// null, e.g. flow-version-backup.service.ts's unscoped rows) requires an exact platformId
// match instead — `IS NOT DISTINCT FROM` treats two NULLs as equal there — and a
// project-scoped caller can never claim one (the second WHERE branch requires
// EXCLUDED.projectId IS NULL too). A mismatch makes the WHERE false, the DO UPDATE becomes
// a no-op, and RETURNING yields zero rows.
const upsertOwnedFile = async ({ baseFile, location, data, s3Key }: UpsertOwnedFileParams): Promise<File> => {
    const rows: { id: string }[] = await fileRepo().query(
        `INSERT INTO "file" ("id", "created", "updated", "projectId", "platformId", "data", "location", "fileName", "size", "metadata", "s3Key", "type", "compression")
         VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT ("id") DO UPDATE SET
             "updated" = now(),
             "data" = EXCLUDED."data",
             "location" = EXCLUDED."location",
             "fileName" = COALESCE(EXCLUDED."fileName", "file"."fileName"),
             "size" = EXCLUDED."size",
             "metadata" = COALESCE(EXCLUDED."metadata", "file"."metadata"),
             "s3Key" = EXCLUDED."s3Key",
             "type" = EXCLUDED."type",
             "compression" = EXCLUDED."compression",
             "platformId" = COALESCE("file"."platformId", EXCLUDED."platformId")
         WHERE (
             "file"."projectId" IS NOT NULL AND "file"."projectId" = EXCLUDED."projectId"
         ) OR (
             "file"."projectId" IS NULL AND EXCLUDED."projectId" IS NULL
             AND "file"."platformId" IS NOT DISTINCT FROM EXCLUDED."platformId"
         )
         RETURNING "id"`,
        [
            baseFile.id,
            baseFile.projectId ?? null,
            baseFile.platformId ?? null,
            data,
            location,
            baseFile.fileName ?? null,
            baseFile.size ?? null,
            isNil(baseFile.metadata) ? null : JSON.stringify(baseFile.metadata),
            s3Key,
            baseFile.type,
            baseFile.compression,
        ],
    )
    if (rows.length === 0) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'File id belongs to a different project or platform',
            },
        }, `Refused to save file ${baseFile.id}: it belongs to a different project/platform than the caller (projectId=${baseFile.projectId ?? 'null'}, platformId=${baseFile.platformId ?? 'null'})`)
    }
    // Re-read through the repo rather than return the raw RETURNING row: this keeps the
    // returned File shaped exactly like every other fileRepo() read in this module, instead
    // of a second, ad hoc column mapping for this one call site. The WHERE clause above
    // already guarantees the row is the caller's, but the re-read is filtered by the
    // caller's own projectId/platformId anyway, per data-isolation.md, rather than by id
    // alone.
    return fileRepo().findOneByOrFail({
        id: baseFile.id,
        ...(!isNil(baseFile.projectId)
            ? { projectId: baseFile.projectId }
            : { platformId: isNil(baseFile.platformId) ? IsNull() : baseFile.platformId }),
    })
}

const saveFileToDb = async (baseFile: BaseFile, data: SaveParams['data']) => {
    assertNotNullOrUndefined(data, 'data is required')
    return upsertOwnedFile({ baseFile, location: FileLocation.DB, data, s3Key: null })
}
export const fileService = (log: FastifyBaseLogger) => ({
    async save(params: SaveParams): Promise<File> {
        const baseFile: BaseFile = {
            id: params.fileId ?? apId(),
            projectId: params.projectId,
            platformId: params.platformId,
            type: params.type,
            fileName: params.fileName,
            compression: params.compression,
            size: params.size,
            metadata: params.metadata,
            created: dayjs().toISOString(),
            updated: dayjs().toISOString(),
        }
        const location = getLocationForFile(params.type)
        switch (location) {
            case FileLocation.DB: {
                return saveFileToDb(baseFile, params.data)
            }
            case FileLocation.S3: {
                try {
                    const s3Key = await s3Helper(log).constructS3Key(params.platformId, params.projectId, params.type, baseFile.id)
                    // The ownership-checked upsert runs BEFORE the upload, not after: the S3 key
                    // template is `platform/${platformId}/${type}/${fileId}` when platformId is
                    // set, which ignores projectId entirely, so two projects on the same platform
                    // can compute the identical "fresh" key for the same fileId — constructS3Key's
                    // own scoped lookup cannot prevent that collision by itself. Refusing here,
                    // before any bytes move, is what actually stops a foreign id from landing on
                    // (or being overwritten by) another project's object (#517).
                    const savedFile = await upsertOwnedFile({ baseFile, location: FileLocation.S3, data: null, s3Key })
                    if (!isNil(params.data)) {
                        await s3Helper(log).uploadFile(s3Key, params.data)
                    }
                    return savedFile
                }
                catch (error) {
                    // An ownership refusal is a QadamFlowError raised by upsertOwnedFile itself,
                    // not an S3 infrastructure failure — it must propagate, never be swallowed into
                    // the DB fallback below (which would otherwise let the caller take the row over
                    // via the DB path after being refused on the S3 path).
                    if (error instanceof QadamFlowError) {
                        throw error
                    }
                    exceptionHandler.handle(error, log)
                    return saveFileToDb(baseFile, params.data)
                }
            }
        }
    },
    async exists(params: GetOneParams): Promise<boolean> {
        const file = await fileRepo().findOneBy({
            projectId: params.projectId,
            id: params.fileId,
            type: normalizeTypeFilter(params.type),
        })
        return !isNil(file)
    },
    async getFile({ projectId, fileId, type }: GetOneParams): Promise<File | null> {
        const file = await fileRepo().findOneBy({
            projectId,
            id: fileId,
            type: normalizeTypeFilter(type),
        })
        return file
    },
    async getFileOrThrow(params: GetOneParams): Promise<File> {
        const file = !isNil(params.fileId) ? await this.getFile(params) : undefined
        if (isNil(file)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'file',
                    entityId: params.fileId,
                    message: 'File not found',
                },
            })
        }
        return file
    },
    async getDataOrUndefined({ projectId, fileId, type }: GetOneParams): Promise<GetDataResponse | undefined> {
        try {
            return await this.getDataOrThrow({ projectId, fileId, type })
        }
        catch (error) {
            log.error({
                error,
            }, '[FileService#getData] error')
            return undefined
        }

    },
    async getDataOrThrow({ projectId, fileId, type }: GetOneParams): Promise<GetDataResponse> {
        const file = await fileRepo().findOneBy({
            projectId,
            id: fileId,
            type: normalizeTypeFilter(type),
        })
        if (isNil(file)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'file',
                    entityId: fileId,
                    message: 'File not found',
                },
            })
        }
        const data = await fileCompressor.decompress({
            data: file.location === FileLocation.DB ? file.data : await s3Helper(log).getFile(file.s3Key!),
            compression: file.compression,
        })
        return {
            metadata: file.metadata ?? undefined,
            data,
            fileName: file.fileName ?? undefined,
        }
    },
    async delete(params: { projectId: ProjectId, fileId: FileId }): Promise<void> {
        const file = await fileRepo().findOneBy({
            id: params.fileId,
            projectId: params.projectId,
        })
        if (isNil(file)) {
            return
        }
        if (!isNil(file.s3Key)) {
            await s3Helper(log).deleteFiles([file.s3Key])
        }
        await fileRepo().delete({ id: file.id })
    },
    async deleteStaleBulk(types: FileType[]) {
        const retentionDateBoundary = dayjs().subtract(EXECUTION_DATA_RETENTION_DAYS, 'days').toISOString()
        const maximumFilesToDeletePerIteration = 4000
        let affected: undefined | number = undefined
        let totalAffected = 0
        while (isNil(affected) || affected === maximumFilesToDeletePerIteration) {
            const staleFiles = await fileRepo().find({
                select: ['id', 'created', 's3Key'],
                where: {
                    type: In(types),
                    created: LessThanOrEqual(retentionDateBoundary),
                },
                take: maximumFilesToDeletePerIteration,
            })

            const s3Keys = staleFiles.filter(f => !isNil(f.s3Key)).map(f => f.s3Key!)
            await s3Helper(log).deleteFiles(s3Keys)

            const result = await fileRepo().delete({
                type: In(types),
                created: LessThanOrEqual(retentionDateBoundary),
                id: In(staleFiles.map(file => file.id)),
            })
            affected = result.affected || 0
            totalAffected += affected
            log.info({
                counts: affected,
                types,
            }, '[FileService#deleteStaleBulk] iteration completed')
        }
        log.info({
            totalAffected,
            types,
        }, '[FileService#deleteStaleBulk] completed')
    },
    async getFileByToken(token: string): Promise<Omit<File, 'data'>> {
        try {
            const decodedToken = await jwtUtils.decodeAndVerify<FileToken>({
                jwt: token,
                key: await jwtUtils.getJwtSecret(),
                // The route this serves is securityAccess.public(), so the JWT is the only thing
                // between an arbitrary token and a file lookup. Without the audience, any token
                // signed with AP_JWT_SECRET clears that check and only the payload shape — needing
                // a `fileId` claim — stops a session or MCP token being replayed here. That is the
                // field naming doing the audience's job by coincidence. filesService.verifyReadToken
                // has always pinned it; this is the same class of token (#251).
                audience: JwtAudience.FILE_READ,
            })
            const fileType = decodedToken.fileType ?? FileType.FLOW_STEP_FILE
            if (!ALLOWED_SIGNED_FILE_TYPES.includes(fileType)) {
                throw new Error(`File type ${fileType} not allowed for signed download`)
            }
            return await this.getFileOrThrow({
                fileId: decodedToken.fileId,
                type: fileType,
            })
        }
        catch (e) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_BEARER_TOKEN,
                params: {
                    message: 'invalid token or expired for the step file',
                },
            })
        }
    },
    extractBufferOrUndefined(value: unknown): Buffer | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        if (Buffer.isBuffer(value)) {
            return value
        }
        if (typeof value === 'string') {
            return Buffer.from(value, 'utf-8')
        }
        if (value instanceof Uint8Array) {
            return Buffer.from(value)
        }
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'File data must be a Buffer' },
        })
    },
    async uploadPublicAsset(params: UploadPublicAssetParams): Promise<string | undefined> {
        const { file, type, platformId, allowedMimeTypes = IMAGE_MIME_TYPES, maxFileSizeInBytes, metadata } = params

        if (isNil(file)) {
            return undefined
        }

        if (!isMultipartFile(file)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'File must be a multipart file',
                },
            })
        }

        if (!allowedMimeTypes.includes(file.mimetype ?? '')) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `Invalid file type. Allowed types: ${allowedMimeTypes.join(', ')}`,
                },
            })
        }

        if (!isNil(maxFileSizeInBytes) && file.data.length > maxFileSizeInBytes) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `File size exceeds ${Math.round(maxFileSizeInBytes / (1024 * 1024))}MB limit`,
                },
            })
        }

        const savedFile = await this.save({
            data: file.data,
            size: file.data.length,
            type,
            compression: FileCompression.NONE,
            platformId,
            fileName: file.filename,
            metadata: {
                ...metadata,
                mimetype: file.mimetype ?? '',
            },
        })

        return `${system.get(AppSystemProp.FRONTEND_URL)}/api/v1/platforms/assets/${savedFile.id}`
    },
})

type GetDataResponse = {
    metadata?: Record<string, string>
    data: Buffer
    fileName?: string
}

function normalizeTypeFilter(type: FileType | FileType[] | undefined) {
    return Array.isArray(type) ? In(type) : type
}

export function getLocationForFile(type: FileType) {
    const FILE_LOCATION = system.getOrThrow<FileLocation>(AppSystemProp.FILE_STORAGE_LOCATION)
    if (isExecutionDataFileThatExpires(type)) {
        return FILE_LOCATION
    }
    return FileLocation.DB
}

function isExecutionDataFileThatExpires(type: FileType) {
    switch (type) {
        case FileType.FLOW_RUN_LOG:
        case FileType.FLOW_RUN_LOG_SLICE:
        case FileType.FLOW_STEP_FILE:
        case FileType.TRIGGER_PAYLOAD:
        case FileType.TRIGGER_EVENT_FILE:
        case FileType.WEBHOOK_PAYLOAD:
            return true
        case FileType.PLATFORM_ASSET:
        case FileType.USER_PROFILE_PICTURE:
        case FileType.SAMPLE_DATA:
        case FileType.SAMPLE_DATA_INPUT:
        case FileType.PACKAGE_ARCHIVE:
        case FileType.PROJECT_RELEASE:
        case FileType.FLOW_VERSION_BACKUP:
        case FileType.KNOWLEDGE_BASE:
            return false
        default:
            throw new Error(`File type ${type} is not supported`)
    }
}

type SaveParams = {
    fileId?: FileId | undefined
    projectId?: ProjectId
    data: Buffer | null
    size: number
    type: FileType
    platformId?: string
    fileName?: string
    compression: FileCompression
    metadata?: Record<string, string>
}

type GetOneParams = {
    fileId?: FileId
    projectId?: ProjectId
    type?: FileType | FileType[]
}

type FileToken = {
    fileId: string
    fileType?: FileType
}

type UploadPublicAssetParams = {
    file: unknown
    type: FileType
    platformId: string
    allowedMimeTypes?: string[]
    maxFileSizeInBytes?: number
    metadata?: Record<string, string>
}
