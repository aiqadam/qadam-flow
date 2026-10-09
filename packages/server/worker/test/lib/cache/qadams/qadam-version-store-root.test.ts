import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApEnvironment, ExecutionMode } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest'
import { qadamVersionStoreRoot } from '../../../../src/lib/cache/qadams/qadam-version-store-root'
import { readOnlyMount } from '../../../../src/lib/cache/qadams/read-only-mount'

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

// The temp directory sits on a writable mount: a store there is refused unless a test says the
// mount table shows it read-only (readOnlyMount has its own tests).
let readOnlyMountSpy: MockInstance<typeof readOnlyMount.check> | null = null

function asReadOnlyMount(): void {
    readOnlyMountSpy = vi.spyOn(readOnlyMount, 'check').mockResolvedValue({ readOnly: true })
}

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
    readOnlyMountSpy?.mockRestore()
    readOnlyMountSpy = null
})

describe('qadamVersionStoreRoot', () => {
    it('hands a store on a read-only mount to forked engines, and an empty value to isolate engines', async () => {
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

    it('keeps the root it opened in an isolate mode, for a later switch to a forked mode', async () => {
        const root = await readOnlyStore()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.SANDBOX_PROCESS })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.SANDBOX_PROCESS })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: root })
    })

    it.each([
        ['writable', 0o755],
        ['read-only by its permission bits only (chmod 555)', 0o555],
    ])('refuses a store that is not on a read-only mount (%s), outside a development environment', async (_label, mode) => {
        await mkdir(join(tempDir, 'store'))
        await chmod(join(tempDir, 'store'), mode)
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.UNSANDBOXED })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: '' })
        expect(warn).toHaveBeenCalledWith({ reason: 'the qadam version store is not on a read-only mount', used: false }, expect.stringContaining('mount the qadam version store read-only on workers'))
    })

    it('uses a writable store in a development environment, with a warning', async () => {
        await mkdir(join(tempDir, 'store'))
        process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'store')

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT, executionMode: ExecutionMode.UNSANDBOXED })

        expect(qadamVersionStoreRoot.engineEnv({ executionMode: ExecutionMode.UNSANDBOXED })).toEqual({ AP_QADAM_VERSION_STORE_PATH: join(tempDir, 'store') })
        expect(warn).toHaveBeenCalledWith({ reason: 'the qadam version store is not on a read-only mount', used: true }, expect.stringContaining('mount the qadam version store read-only on workers'))
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

    it('logs an unusable store at info in a development environment', async () => {
        await unusableStore()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.DEVELOPMENT, executionMode: ExecutionMode.UNSANDBOXED })

        expect(warn).not.toHaveBeenCalled()
        expect(info).toHaveBeenCalledWith({ reason: expect.any(String) }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })

    it('logs an unusable store at warn outside development, in an isolate mode too', async () => {
        await unusableStore()

        await qadamVersionStoreRoot.prepare({ log, environment: ApEnvironment.PRODUCTION, executionMode: ExecutionMode.SANDBOX_PROCESS })

        expect(warn).toHaveBeenCalledWith({ reason: expect.any(String) }, expect.stringContaining('[qadamVersionStore] The qadam version store is unavailable'))
    })
})

async function unusableStore(): Promise<void> {
    await mkdir(join(tempDir, 'app', 'qadam-versions'), { recursive: true })
    await mkdir(join(tempDir, 'app', 'node_modules'))
    process.env['AP_QADAM_VERSION_STORE_PATH'] = join(tempDir, 'app', 'qadam-versions')
}

async function readOnlyStore(): Promise<string> {
    const root = join(tempDir, 'store')
    await mkdir(root)
    process.env['AP_QADAM_VERSION_STORE_PATH'] = root
    asReadOnlyMount()
    return root
}
