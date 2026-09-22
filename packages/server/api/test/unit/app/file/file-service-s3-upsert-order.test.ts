import { ErrorCode, FileCompression, FileType } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockFindOneByOrFail = vi.fn()
const mockConstructS3Key = vi.fn()
const mockUploadFile = vi.fn()
let callOrder: string[] = []

vi.mock('../../../../src/app/file/file.entity', () => ({
    FileEntity: {},
}))

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: vi.fn(() => () => ({
        query: mockQuery,
        findOneByOrFail: mockFindOneByOrFail,
        findOneBy: vi.fn(),
        save: vi.fn(),
        find: vi.fn(),
        delete: vi.fn(),
    })),
}))

vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        getOrThrow: vi.fn().mockReturnValue('S3'),
        getNumberOrThrow: vi.fn().mockReturnValue(30),
        getNumber: vi.fn().mockReturnValue(undefined),
        get: vi.fn().mockReturnValue(undefined),
    },
}))

vi.mock('../../../../src/app/helper/exception-handler', () => ({
    exceptionHandler: { handle: vi.fn() },
}))

vi.mock('../../../../src/app/file/s3-helper', () => ({
    s3Helper: vi.fn(() => ({
        constructS3Key: mockConstructS3Key,
        uploadFile: mockUploadFile,
        deleteFiles: vi.fn(),
        getFile: vi.fn(),
    })),
}))

vi.mock('../../../../src/app/file/file-compressor', () => ({
    fileCompressor: { compress: vi.fn(), decompress: vi.fn() },
}))

import { fileService } from '../../../../src/app/file/file.service'

const mockLog = {
    info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn(),
    child: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn(), level: 'info',
} as any

const saveParams = {
    fileId: 'file-1',
    projectId: 'proj-a',
    platformId: 'platform-1',
    type: FileType.FLOW_STEP_FILE,
    fileName: 'hello.txt',
    compression: FileCompression.NONE,
    size: 3,
    data: Buffer.from('abc'),
}

// #517: an engine token for project A must never overwrite an S3 object belonging to another
// project's row, but the S3 key template (`platform/${platformId}/${type}/${fileId}`) ignores
// projectId — two projects on the same platform compute the identical "fresh" key. The only
// thing that actually stops the overwrite is doing the ownership-checked DB upsert BEFORE the
// upload, so a refusal moves zero bytes. These drive fileService.save directly, with the repo
// and s3Helper mocked, so the ordering is observable without a real S3 backend.
describe('fileService.save S3 branch — ownership-checked upsert runs before the upload (#517)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        callOrder = []
        mockConstructS3Key.mockResolvedValue('platform/platform-1/FLOW_STEP_FILE/file-1')
        mockUploadFile.mockImplementation(async () => {
            callOrder.push('upload')
            return 'platform/platform-1/FLOW_STEP_FILE/file-1'
        })
    })

    it('uploads only after the ownership-checked upsert succeeds', async () => {
        mockQuery.mockImplementation(async () => {
            callOrder.push('upsert')
            return [{ id: 'file-1' }]
        })
        mockFindOneByOrFail.mockResolvedValue({
            id: 'file-1',
            projectId: 'proj-a',
            platformId: 'platform-1',
            data: null,
            location: 'S3',
            fileName: 'hello.txt',
            size: 3,
            metadata: null,
            s3Key: 'platform/platform-1/FLOW_STEP_FILE/file-1',
            type: FileType.FLOW_STEP_FILE,
            compression: FileCompression.NONE,
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
        })

        const result = await fileService(mockLog).save(saveParams)

        expect(result.id).toBe('file-1')
        expect(callOrder).toEqual(['upsert', 'upload'])
    })

    it('never uploads when the ownership check refuses the row', async () => {
        mockQuery.mockImplementation(async () => {
            callOrder.push('upsert')
            return []
        })

        await expect(fileService(mockLog).save(saveParams)).rejects.toMatchObject({
            error: { code: ErrorCode.AUTHORIZATION },
        })

        expect(mockUploadFile).not.toHaveBeenCalled()
        expect(callOrder).toEqual(['upsert'])
    })
})
