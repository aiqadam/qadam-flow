import { ContextVersion, QadamMetadata } from '@aiqadam/qadams-framework'
import {
    EngineResponse,
    EngineResponseStatus,
    FileCompression,
    FileType,
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { ObjectLiteral } from 'typeorm'
import { MockInstance } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { fileService } from '../../../../src/app/file/file.service'
import { qadamContextVersionBackfill } from '../../../../src/app/qadams/qadam-context-version-backfill'
import { userInteractionWatcher } from '../../../../src/app/workers/user-interaction-watcher'
import { createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger
let interactionSpy: MockInstance

const LOADABLE = 'loadable-qadam'
const LOADABLE_NO_CONTEXT_INFO = 'loadable-old-qadam'
const UNLOADABLE = 'unloadable-qadam'
const NO_ARCHIVE = 'no-archive-qadam'
const ALREADY_KNOWN = 'known-qadam'
const OFFICIAL = 'official-row-qadam'

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('qadam_metadata').createQueryBuilder().delete().execute()
    interactionSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async (request) => {
        const qadamName = 'qadam' in request ? request.qadam.qadamName : undefined
        switch (qadamName) {
            case LOADABLE:
                return okResponse({ name: LOADABLE, contextInfo: { version: ContextVersion.V1 } })
            case LOADABLE_NO_CONTEXT_INFO:
                return okResponse({ name: LOADABLE_NO_CONTEXT_INFO, contextInfo: undefined })
            default:
                return { status: EngineResponseStatus.INTERNAL_ERROR, response: undefined, error: 'Cannot find module' }
        }
    })
})

afterEach(() => {
    interactionSpy.mockRestore()
})

describe('qadamContextVersionBackfill (#802)', () => {
    it('fills the context version of a custom qadam whose stored archive loads', async () => {
        const { platformId } = await setup()
        const updatedBefore = '2026-01-02T03:04:05.000Z'
        await saveRow({ name: LOADABLE, platformId, archiveId: await saveArchive(platformId), updated: updatedBefore })
        await saveRow({ name: LOADABLE_NO_CONTEXT_INFO, platformId, archiveId: await saveArchive(platformId) })

        const result = await qadamContextVersionBackfill(mockLog).run()

        expect(result).toEqual({ resolved: 2, unknown: 0 })
        const loadable = await findRow(LOADABLE)
        expect(loadable.contextVersion).toBe(ContextVersion.V1)
        expect(new Date(loadable.updated).toISOString()).toBe(updatedBefore)
        expect((await findRow(LOADABLE_NO_CONTEXT_INFO)).contextVersion).toBe('NONE')
        expect(interactionSpy).toHaveBeenCalledWith(expect.objectContaining({
            platformId,
            qadam: expect.objectContaining({ qadamName: LOADABLE, packageType: PackageType.ARCHIVE, platformId }),
        }), expect.anything())
    })

    it('leaves a row unknown when its archive cannot be loaded', async () => {
        const { platformId } = await setup()
        await saveRow({ name: UNLOADABLE, platformId, archiveId: await saveArchive(platformId) })

        const result = await qadamContextVersionBackfill(mockLog).run()

        expect(result).toEqual({ resolved: 0, unknown: 1 })
        expect((await findRow(UNLOADABLE)).contextVersion).toBeNull()
        expect(interactionSpy).toHaveBeenCalledTimes(1)
    })

    it('leaves an archive row with no stored archive unknown without dispatching any engine job', async () => {
        const { platformId } = await setup()
        await saveRow({ name: NO_ARCHIVE, platformId, archiveId: undefined })

        const result = await qadamContextVersionBackfill(mockLog).run()

        expect(result).toEqual({ resolved: 0, unknown: 1 })
        expect((await findRow(NO_ARCHIVE)).contextVersion).toBeNull()
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    it('touches neither a row whose version is already known nor a row with no platform', async () => {
        const { platformId } = await setup()
        await saveRow({ name: ALREADY_KNOWN, platformId, archiveId: await saveArchive(platformId), contextVersion: ContextVersion.V2 })
        await saveRow({ name: OFFICIAL, platformId: undefined, archiveId: undefined, qadamType: QadamType.OFFICIAL, packageType: PackageType.REGISTRY })

        const result = await qadamContextVersionBackfill(mockLog).run()

        expect(result).toEqual({ resolved: 0, unknown: 0 })
        expect((await findRow(ALREADY_KNOWN)).contextVersion).toBe(ContextVersion.V2)
        expect((await findRow(OFFICIAL)).contextVersion).toBeNull()
        expect(interactionSpy).not.toHaveBeenCalled()
    })
})

async function setup(): Promise<{ platformId: string }> {
    const ctx = await createTestContext(app!)
    return { platformId: ctx.platform.id }
}

async function saveArchive(platformId: string): Promise<string> {
    const data = Buffer.from('not a real tarball')
    const file = await fileService(mockLog).save({
        platformId,
        data,
        size: data.length,
        type: FileType.PACKAGE_ARCHIVE,
        compression: FileCompression.NONE,
    })
    return file.id
}

async function saveRow({ name, platformId, archiveId, updated, contextVersion = null, qadamType = QadamType.CUSTOM, packageType = PackageType.ARCHIVE }: SaveRowParams): Promise<void> {
    const row = createMockQadamMetadata({
        name,
        version: '1.0.0',
        platformId,
        archiveId,
        qadamType,
        packageType,
        ...(updated ? { updated } : {}),
    })
    await databaseConnection().getRepository('qadam_metadata').insert({ ...row, contextVersion })
}

async function findRow(name: string): Promise<ObjectLiteral> {
    return databaseConnection().getRepository('qadam_metadata').findOneByOrFail({ name })
}

function okResponse({ name, contextInfo }: { name: string, contextInfo: { version: ContextVersion } | undefined }): EngineResponse<QadamMetadata> {
    return {
        status: EngineResponseStatus.OK,
        response: { ...createMockQadamMetadata({ name, version: '1.0.0' }), contextInfo },
        error: undefined,
    }
}

type SaveRowParams = {
    name: string
    platformId: string | undefined
    archiveId: string | undefined
    updated?: string
    contextVersion?: string | null
    qadamType?: QadamType
    packageType?: PackageType
}
