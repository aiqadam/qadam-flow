import { apId, ErrorCode, FileCompression, FileType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { fileRepo, fileService } from '../../../../src/app/file/file.service'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('fileService.save ownership (#517)', () => {
    it('refuses to move a platform-level file (projectId null) into a project', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const { mockProject: attackerProject } = await mockAndSaveBasicSetup()
        const fileId = apId()

        const platformFile = await fileService(app!.log).save({
            fileId,
            platformId: mockPlatform.id,
            type: FileType.PLATFORM_ASSET,
            fileName: 'logo.png',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('abc'),
        })
        expect(platformFile.projectId).toBeNull()

        await expect(fileService(app!.log).save({
            fileId,
            projectId: attackerProject.id,
            platformId: attackerProject.platformId,
            type: FileType.PLATFORM_ASSET,
            fileName: 'logo.png',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('xyz'),
        })).rejects.toMatchObject({ error: { code: ErrorCode.AUTHORIZATION } })

        const row = await fileRepo().findOneBy({ id: fileId })
        expect(row?.projectId ?? null).toBeNull()
        expect(row?.platformId).toBe(mockPlatform.id)
        expect(row?.data.toString('utf-8')).toBe('abc')
    })

    // The test above alone would still pass with a plain `=` comparison (attackerProject's
    // platformId differs from mockPlatform's). The next two tests exercise the cases that
    // actually require `IS NOT DISTINCT FROM` / the COALESCE backfill: a NULL already on one
    // side of the match.
    // flow-version-backup.service.ts saves with neither projectId nor platformId set at all, so
    // both sides of the platformId comparison are NULL on a legitimate re-save. A plain `=`
    // comparison evaluates NULL = NULL to NULL (i.e. false), which would incorrectly refuse this;
    // only `IS NOT DISTINCT FROM` treats the two NULLs as equal and lets the resave through.
    it('lets a fully-unscoped file (no projectId, no platformId) be resaved in place', async () => {
        const fileId = apId()

        await fileService(app!.log).save({
            fileId,
            type: FileType.FLOW_VERSION_BACKUP,
            fileName: 'backup-v1.json',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('abc'),
        })

        const resaved = await fileService(app!.log).save({
            fileId,
            type: FileType.FLOW_VERSION_BACKUP,
            fileName: 'backup-v2.json',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('xyz'),
        })

        expect(resaved.projectId ?? null).toBeNull()
        expect(resaved.platformId ?? null).toBeNull()
        const row = await fileRepo().findOneBy({ id: fileId })
        expect(row?.data.toString('utf-8')).toBe('xyz')
        expect(row?.fileName).toBe('backup-v2.json')
    })

    // Simulates a legacy row on an upgraded install: a file saved before platformId was
    // recorded for its type (or by any code path that once omitted it) has platformId NULL
    // in the database, while the current caller now supplies one on resave. The two NULLs
    // aren't consistently NULL here — one side changes — so this needs the COALESCE backfill,
    // not just IS NOT DISTINCT FROM (which round 1 already had on both columns).
    it('lets the same project resave a file whose existing row predates platformId being recorded, and backfills platformId', async () => {
        const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
        const fileId = apId()

        const created = await fileService(app!.log).save({
            fileId,
            projectId: mockProject.id,
            type: FileType.SAMPLE_DATA,
            fileName: 'sample-v1.json',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('abc'),
        })
        expect(created.platformId ?? null).toBeNull()

        const resaved = await fileService(app!.log).save({
            fileId,
            projectId: mockProject.id,
            platformId: mockPlatform.id,
            type: FileType.SAMPLE_DATA,
            fileName: 'sample-v2.json',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('xyz'),
        })

        expect(resaved.platformId).toBe(mockPlatform.id)
        const row = await fileRepo().findOneBy({ id: fileId })
        expect(row?.data.toString('utf-8')).toBe('xyz')
        expect(row?.platformId).toBe(mockPlatform.id)
    })

    it('lets the same platform overwrite its own platform-level file id', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const fileId = apId()

        await fileService(app!.log).save({
            fileId,
            platformId: mockPlatform.id,
            type: FileType.PLATFORM_ASSET,
            fileName: 'logo.png',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('abc'),
        })

        await fileService(app!.log).save({
            fileId,
            platformId: mockPlatform.id,
            type: FileType.PLATFORM_ASSET,
            fileName: 'logo-v2.png',
            compression: FileCompression.NONE,
            size: 3,
            data: Buffer.from('xyz'),
        })

        const row = await fileRepo().findOneBy({ id: fileId })
        expect(row?.data.toString('utf-8')).toBe('xyz')
        expect(row?.fileName).toBe('logo-v2.png')
    })
})
