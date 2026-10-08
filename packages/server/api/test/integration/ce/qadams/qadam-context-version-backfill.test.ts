import { ContextVersion } from '@aiqadam/qadams-framework'
import {
    EngineResponse,
    EngineResponseStatus,
    FileCompression,
    FileType,
    MachineInformation,
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { ObjectLiteral } from 'typeorm'
import { MockInstance } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { fileService } from '../../../../src/app/file/file.service'
import { UNRECOGNISED_CONTEXT_VERSION } from '../../../../src/app/qadams/metadata/qadam-context-version'
import { MAX_ATTEMPTS, MAX_ROWS_PER_RUN, qadamContextVersionBackfill } from '../../../../src/app/qadams/qadam-context-version-backfill'
import { workerMachineCache } from '../../../../src/app/workers/machine/machine-cache'
import { userInteractionWatcher } from '../../../../src/app/workers/user-interaction-watcher'
import { createMockQadamMetadata } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger
let interactionSpy: MockInstance

const FAKE_WORKER_ID = 'qadam-context-version-backfill-test-worker'

// The mocked worker answers by qadam name: `v1-*` loads and reports V1, `none-*` loads and reports
// nothing, `weird-*` loads and reports a version no shim matches, `hang-*` never answers (the
// watcher's safety timeout), anything else fails to load.
beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('qadam_metadata').createQueryBuilder().delete().execute()
    await workerMachineCache().upsert({ id: FAKE_WORKER_ID, information: fakeMachineInfo(), type: 'SHARED' })
    interactionSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockImplementation(async (request) => {
        const qadamName = 'qadam' in request ? request.qadam.qadamName : ''
        if (qadamName.startsWith('hang-')) {
            throw new Error('Worker did not respond within the safety timeout')
        }
        if (qadamName.startsWith('v1-')) {
            return okResponse({ name: qadamName, contextInfo: { version: ContextVersion.V1 } })
        }
        if (qadamName.startsWith('none-')) {
            return okResponse({ name: qadamName, contextInfo: undefined })
        }
        if (qadamName.startsWith('weird-')) {
            return okResponse({ name: qadamName, contextInfo: { version: '99' } })
        }
        return { status: EngineResponseStatus.INTERNAL_ERROR, response: undefined, error: 'Cannot find module' }
    })
})

afterEach(async () => {
    interactionSpy.mockRestore()
    await workerMachineCache().delete([FAKE_WORKER_ID])
})

describe('qadamContextVersionBackfill (#802)', () => {
    it('fills the context version of custom qadams that load, archive and registry alike', async () => {
        const { platformId } = await setup()
        const updatedBefore = '2026-01-02T03:04:05.000Z'
        await saveRow({ name: 'v1-archive', platformId, archiveId: await saveArchive(platformId), updated: updatedBefore })
        await saveRow({ name: 'none-archive', platformId, archiveId: await saveArchive(platformId) })
        await saveRow({ name: 'v1-registry', platformId, archiveId: undefined, packageType: PackageType.REGISTRY })

        const result = await qadamContextVersionBackfill(mockLog).run()

        expect(result).toEqual({ resolved: 3, failed: 0, stoppedEarly: false })
        const archive = await findRow('v1-archive')
        expect(archive.contextVersion).toBe(ContextVersion.V1)
        expect(archive.contextVersionAttempts).toBe(0)
        expect(new Date(archive.updated).toISOString()).toBe(updatedBefore)
        expect((await findRow('none-archive')).contextVersion).toBe('NONE')
        expect((await findRow('v1-registry')).contextVersion).toBe(ContextVersion.V1)
        expect(interactionSpy).toHaveBeenCalledWith(expect.objectContaining({
            platformId,
            qadam: expect.objectContaining({ qadamName: 'v1-archive', packageType: PackageType.ARCHIVE, platformId }),
        }), expect.anything())
        expect(interactionSpy).toHaveBeenCalledWith(expect.objectContaining({
            qadam: { qadamName: 'v1-registry', qadamVersion: '1.0.0', packageType: PackageType.REGISTRY, qadamType: QadamType.CUSTOM, platformId },
        }), expect.anything())
    })

    // The DoS the review named: a qadam built to report garbage must not be reloaded on every run.
    it('stores UNRECOGNISED for a qadam that loads but reports an unknown version, and never loads it again', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'weird-archive', platformId, archiveId: await saveArchive(platformId) })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 1, failed: 0, stoppedEarly: false })
        expect((await findRow('weird-archive')).contextVersion).toBe(UNRECOGNISED_CONTEXT_VERSION)

        interactionSpy.mockClear()
        await qadamContextVersionBackfill(mockLog).run()
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    it('leaves a row whose archive cannot be loaded unknown, records the attempt, and backs off', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'broken-archive', platformId, archiveId: await saveArchive(platformId) })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 1, stoppedEarly: false })
        const afterFirst = await findRow('broken-archive')
        expect(afterFirst.contextVersion).toBeNull()
        expect(afterFirst.contextVersionAttempts).toBe(1)
        expect(afterFirst.contextVersionLastAttemptAt).not.toBeNull()

        // Inside the 6 h gap: not tried again.
        interactionSpy.mockClear()
        await qadamContextVersionBackfill(mockLog).run()
        expect(interactionSpy).not.toHaveBeenCalled()

        // Past it: tried again.
        await setLastAttempt({ name: 'broken-archive', hoursAgo: 7 })
        await qadamContextVersionBackfill(mockLog).run()
        expect(interactionSpy).toHaveBeenCalledTimes(1)
        expect((await findRow('broken-archive')).contextVersionAttempts).toBe(2)
    })

    it('never loads a row again once it used up its attempts', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'broken-archive', platformId, archiveId: await saveArchive(platformId), contextVersionAttempts: MAX_ATTEMPTS })
        await setLastAttempt({ name: 'broken-archive', hoursAgo: 24 * 365 })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 0, stoppedEarly: false })
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    it('leaves an archive row with no stored archive unknown without dispatching any engine job', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'v1-no-archive', platformId, archiveId: undefined })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 1, stoppedEarly: false })
        const row = await findRow('v1-no-archive')
        expect(row.contextVersion).toBeNull()
        expect(row.contextVersionAttempts).toBe(1)
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    // Security control (#503): a worker would install this into the workspace every tenant shares.
    it('never hands a custom row under the official @aiqadam/ scope to a worker', async () => {
        const { platformId } = await setup()
        await saveRow({ name: '@aiqadam/qadam-slack', platformId, archiveId: await saveArchive(platformId) })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 1, stoppedEarly: false })
        expect((await findRow('@aiqadam/qadam-slack')).contextVersion).toBeNull()
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    it('touches neither a known row, an official row, nor a custom row with no platform', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'v1-known', platformId, archiveId: await saveArchive(platformId), contextVersion: ContextVersion.V2 })
        await saveRow({ name: 'v1-official', platformId: undefined, archiveId: undefined, qadamType: QadamType.OFFICIAL, packageType: PackageType.REGISTRY })
        await saveRow({ name: 'v1-custom-no-platform', platformId: undefined, archiveId: undefined, packageType: PackageType.REGISTRY })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 0, stoppedEarly: false })
        expect((await findRow('v1-known')).contextVersion).toBe(ContextVersion.V2)
        expect((await findRow('v1-official')).contextVersion).toBeNull()
        expect((await findRow('v1-custom-no-platform')).contextVersion).toBeNull()
        expect(interactionSpy).not.toHaveBeenCalled()
    })

    it('loads at most MAX_ROWS_PER_RUN rows per run, and the next run continues', async () => {
        const { platformId } = await setup()
        const total = MAX_ROWS_PER_RUN + 2
        for (let index = 0; index < total; index++) {
            await saveRow({ name: `v1-registry-${index}`, platformId, archiveId: undefined, packageType: PackageType.REGISTRY })
        }

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: MAX_ROWS_PER_RUN, failed: 0, stoppedEarly: false })
        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 2, failed: 0, stoppedEarly: false })
        expect(interactionSpy).toHaveBeenCalledTimes(total)
    })

    it('dispatches nothing and records nothing when no worker is online', async () => {
        const { platformId } = await setup()
        await workerMachineCache().delete([FAKE_WORKER_ID])
        await saveRow({ name: 'v1-archive', platformId, archiveId: await saveArchive(platformId) })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 0, stoppedEarly: true })
        expect(interactionSpy).not.toHaveBeenCalled()
        expect((await findRow('v1-archive')).contextVersionAttempts).toBe(0)
    })

    it('stops the run at the first row no worker answers, instead of waiting it out for every row', async () => {
        const { platformId } = await setup()
        await saveRow({ name: 'hang-archive', platformId, archiveId: await saveArchive(platformId), created: '2026-01-01T00:00:00.000Z' })
        await saveRow({ name: 'v1-archive', platformId, archiveId: await saveArchive(platformId), created: '2026-01-02T00:00:00.000Z' })

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 0, failed: 1, stoppedEarly: true })
        expect(interactionSpy).toHaveBeenCalledTimes(1)
        // The hanging row counts an attempt, so it backs off and stops holding the head of the queue.
        expect((await findRow('hang-archive')).contextVersionAttempts).toBe(1)
        expect((await findRow('v1-archive')).contextVersion).toBeNull()

        expect(await qadamContextVersionBackfill(mockLog).run()).toEqual({ resolved: 1, failed: 0, stoppedEarly: false })
        expect((await findRow('v1-archive')).contextVersion).toBe(ContextVersion.V1)
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

async function saveRow({ name, platformId, archiveId, updated, created, contextVersion = null, contextVersionAttempts = 0, qadamType = QadamType.CUSTOM, packageType = PackageType.ARCHIVE }: SaveRowParams): Promise<void> {
    const row = createMockQadamMetadata({
        name,
        version: '1.0.0',
        platformId,
        archiveId,
        qadamType,
        packageType,
        ...(updated ? { updated } : {}),
        ...(created ? { created } : {}),
    })
    await databaseConnection().getRepository('qadam_metadata').insert({ ...row, contextVersion, contextVersionAttempts })
}

async function setLastAttempt({ name, hoursAgo }: { name: string, hoursAgo: number }): Promise<void> {
    await databaseConnection().getRepository('qadam_metadata').update({ name }, {
        contextVersionLastAttemptAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    })
}

async function findRow(name: string): Promise<ObjectLiteral> {
    return databaseConnection().getRepository('qadam_metadata').findOneByOrFail({ name })
}

function okResponse({ name, contextInfo }: { name: string, contextInfo: unknown }): EngineResponse<unknown> {
    return {
        status: EngineResponseStatus.OK,
        response: { ...createMockQadamMetadata({ name, version: '1.0.0' }), contextInfo },
        error: undefined,
    }
}

function fakeMachineInfo(): MachineInformation {
    return {
        workerId: FAKE_WORKER_ID,
        cpuUsagePercentage: 0,
        ramUsagePercentage: 0,
        totalAvailableRamInBytes: 0,
        totalCpuCores: 1,
        ip: '127.0.0.1',
        diskInfo: { total: 100, free: 50, used: 50, percentage: 50 },
        workerProps: { version: '1.1.0' },
        sandboxes: [],
    }
}

type SaveRowParams = {
    name: string
    platformId: string | undefined
    archiveId: string | undefined
    updated?: string
    created?: string
    contextVersion?: string | null
    contextVersionAttempts?: number
    qadamType?: QadamType
    packageType?: PackageType
}
