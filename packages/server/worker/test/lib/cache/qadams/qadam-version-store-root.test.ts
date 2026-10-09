import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApEnvironment, ExecutionMode } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamVersionStoreRoot } from '../../../../src/lib/cache/qadams/qadam-version-store-root'

const log = pino({ level: 'silent' })
const info = vi.spyOn(log, 'info')
const warn = vi.spyOn(log, 'warn')

let tempDir: string
let previousStorePath: string | undefined

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'worker-qadam-store-')))
    previousStorePath = process.env['AP_QADAM_VERSION_STORE_PATH']
    info.mockClear()
    warn.mockClear()
})

afterEach(async () => {
    if (previousStorePath === undefined) {
        delete process.env['AP_QADAM_VERSION_STORE_PATH']
    }
    else {
        process.env['AP_QADAM_VERSION_STORE_PATH'] = previousStorePath
    }
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreRoot', () => {
    it('hands a store it opened to forked engines, and an empty value to isolate engines', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION })

        const env = { AP_QADAM_VERSION_STORE_PATH: join(tempDir, 'store') }
        const none = { AP_QADAM_VERSION_STORE_PATH: '' }
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual(env)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_CODE_ONLY })).toEqual(env)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_PROCESS })).toEqual(none)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_CODE_AND_PROCESS })).toEqual(none)
        expect(warn).not.toHaveBeenCalled()
    })

    it('never writes the store: it creates nothing, not even a missing root', async () => {
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')
        await mkdir(join(tempDir, 'store'))

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION })
        expect(await readdir(join(tempDir, 'store'))).toEqual([])

        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'missing')
        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION })
        await expect(stat(join(tempDir, 'missing'))).rejects.toThrow()
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
    })

    it('hands no store over when it cannot open one, and says why', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')
        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION })
        await mkdir(join(tempDir, 'app', 'qadam-versions'), { recursive: true })
        await mkdir(join(tempDir, 'app', 'node_modules'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'app', 'qadam-versions')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(warn).toHaveBeenCalledWith({ reason: 'stored versions could resolve packages from a node_modules above the store' }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })

    it('logs an unusable store at info in a development environment', async () => {
        await mkdir(join(tempDir, 'app', 'node_modules'), { recursive: true })
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'app', 'qadam-versions')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT })

        expect(warn).not.toHaveBeenCalled()
        expect(info).toHaveBeenCalledWith({ reason: expect.any(String) }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })
})
