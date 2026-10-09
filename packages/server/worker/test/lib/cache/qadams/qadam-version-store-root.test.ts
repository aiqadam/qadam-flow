import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApEnvironment, ExecutionMode } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamVersionStoreRoot } from '../../../../src/lib/cache/qadams/qadam-version-store-root'

const log = pino({ level: 'silent' })
const info = vi.spyOn(log, 'info')
const warn = vi.spyOn(log, 'warn')
// root ignores directory permissions, so a 0555 directory still reads as writable to it.
const isRoot = process.getuid?.() === 0

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
    await chmod(tempDir, 0o755)
    for (const entry of await readdir(tempDir)) {
        await chmod(join(tempDir, entry), 0o755).catch(() => undefined)
    }
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreRoot', () => {
    it.skipIf(isRoot)('hands a read-only store to forked engines, and an empty value to isolate engines', async () => {
        const root = await readOnlyStore()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.UNSANDBOXED })

        const env = { AP_QADAM_VERSION_STORE_PATH: root }
        const none = { AP_QADAM_VERSION_STORE_PATH: '' }
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual(env)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_CODE_ONLY })).toEqual(env)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_PROCESS })).toEqual(none)
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_CODE_AND_PROCESS })).toEqual(none)
        expect(warn).not.toHaveBeenCalled()
    })

    it.skipIf(isRoot)('keeps the root it opened in an isolate mode, for a later switch to a forked mode', async () => {
        const root = await readOnlyStore()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.SANDBOX_PROCESS })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_PROCESS })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: root })
    })

    it('refuses a store this worker can write, outside a development environment', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.UNSANDBOXED })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(warn).toHaveBeenCalledWith({ used: false }, expect.stringContaining('mount the qadam version store read-only on workers'))
    })

    it('uses a writable store in a development environment, with a warning', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT, executionMode: ExecutionMode.UNSANDBOXED })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: join(tempDir, 'store') })
        expect(warn).toHaveBeenCalledWith({ used: true }, expect.stringContaining('mount the qadam version store read-only on workers'))
    })

    it('never writes the store: it creates nothing, not even a missing root', async () => {
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')
        await mkdir(join(tempDir, 'store'))

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT, executionMode: ExecutionMode.UNSANDBOXED })
        expect(await readdir(join(tempDir, 'store'))).toEqual([])

        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'missing')
        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.UNSANDBOXED })
        await expect(stat(join(tempDir, 'missing'))).rejects.toThrow()
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
    })

    it('hands no store over when it cannot open one, and says why', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')
        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT, executionMode: ExecutionMode.UNSANDBOXED })
        await mkdir(join(tempDir, 'app', 'qadam-versions'), { recursive: true })
        await mkdir(join(tempDir, 'app', 'node_modules'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'app', 'qadam-versions')
        warn.mockClear()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.UNSANDBOXED })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(warn).toHaveBeenCalledWith({ reason: 'stored versions could resolve packages from a node_modules above the store' }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })

    it.each([
        ['a development environment', ApEnvironment.DEVELOPMENT, ExecutionMode.UNSANDBOXED],
        ['an execution mode that does not use the store', ApEnvironment.PRODUCTION, ExecutionMode.SANDBOX_PROCESS],
    ])('logs an unusable store at info in %s', async (_label, environment, executionMode) => {
        await mkdir(join(tempDir, 'app', 'qadam-versions'), { recursive: true })
        await mkdir(join(tempDir, 'app', 'node_modules'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'app', 'qadam-versions')

        await qadamVersionStoreRoot.prepare({ log, environment, executionMode })

        expect(warn).not.toHaveBeenCalled()
        expect(info).toHaveBeenCalledWith({ reason: expect.any(String) }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })
})

async function readOnlyStore(): Promise<string> {
    const root = join(tempDir, 'store')
    await mkdir(root)
    await chmod(root, 0o555)
    process.env['AP_QADAM_VERSION_STORE_PATH'] = root
    return root
}
