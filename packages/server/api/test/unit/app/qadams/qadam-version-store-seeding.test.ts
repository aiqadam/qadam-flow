import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamVersionStoreSeeding } from '../../../../src/app/qadams/version-store/qadam-version-store-seeding'

const runExclusive = vi.fn()

vi.mock('../../../../src/app/database/redis-connections', () => ({
    distributedLock: () => ({ runExclusive: (params: LockParams) => runExclusive(params) }),
}))

const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const SEED_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_SEED_PATH}`
const original = { store: process.env[STORE_ENV], seed: process.env[SEED_ENV] }

let tempDir: string
const logger = pino({ level: 'silent' })
const log = { info: vi.spyOn(logger, 'info'), warn: vi.spyOn(logger, 'warn') }

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-seeding-')))
    process.env[STORE_ENV] = join(tempDir, 'store')
    process.env[SEED_ENV] = join(tempDir, 'seed')
    runExclusive.mockReset()
    runExclusive.mockImplementation(async ({ fn }: LockParams) => fn(new AbortController().signal))
    log.info.mockClear()
    log.warn.mockClear()
})

afterEach(async () => {
    restoreEnv({ name: STORE_ENV, value: original.store })
    restoreEnv({ name: SEED_ENV, value: original.seed })
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreSeeding', () => {
    it('creates the store and seeds under one distributed lock, logging that the image had no seed', async () => {
        await qadamVersionStoreSeeding(logger).run()

        expect(runExclusive).toHaveBeenCalledWith(expect.objectContaining({ key: 'qadam-version-store-seed' }))
        expect((await readdir(join(tempDir, 'store'))).sort()).toEqual(['.staging', '.trash', 'qadams'])
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ status: 'no-seed', stored: 0, kept: 0 }), expect.stringContaining('Seeded the qadam version store'))
        expect(log.warn).not.toHaveBeenCalled()
    })

    it('warns about a seed the image carries but the platform cannot read', async () => {
        await mkdir(join(tempDir, 'seed'))
        await writeFile(join(tempDir, 'seed', 'archive-index.json'), '{ not json')

        await qadamVersionStoreSeeding(logger).run()

        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid-seed' }), expect.stringContaining('with problems'))
    })

    it('never throws: an unusable store directory is a warning and nothing is locked', async () => {
        await writeFile(join(tempDir, 'not-a-directory'), '')
        process.env[STORE_ENV] = join(tempDir, 'not-a-directory', 'store')

        await expect(qadamVersionStoreSeeding(logger).run()).resolves.toBeUndefined()

        expect(runExclusive).not.toHaveBeenCalled()
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('cannot be prepared') }), expect.stringContaining('unavailable'))
    })

    it('reports an unusable store at info, not warn, in a dev tree', async () => {
        const environment = process.env.AP_ENVIRONMENT
        process.env.AP_ENVIRONMENT = 'dev'
        await writeFile(join(tempDir, 'not-a-directory'), '')
        process.env[STORE_ENV] = join(tempDir, 'not-a-directory', 'store')

        await qadamVersionStoreSeeding(logger).run()

        restoreEnv({ name: 'AP_ENVIRONMENT', value: environment })
        expect(log.warn).not.toHaveBeenCalled()
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('cannot be prepared') }), expect.stringContaining('unavailable'))
    })

    it('never throws when the lock cannot be taken', async () => {
        runExclusive.mockRejectedValue(new Error('redis is down'))

        await expect(qadamVersionStoreSeeding(logger).run()).resolves.toBeUndefined()

        expect(log.warn).toHaveBeenCalledWith({ error: 'redis is down' }, expect.stringContaining('Seeding the qadam version store failed'))
    })
})

function restoreEnv({ name, value }: { name: string, value: string | undefined }): void {
    if (value === undefined) {
        delete process.env[name]
        return
    }
    process.env[name] = value
}

type LockParams = {
    key: string
    fn: (signal: AbortSignal) => Promise<unknown>
}
