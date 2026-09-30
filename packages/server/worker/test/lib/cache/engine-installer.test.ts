import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApEnvironment } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
let originalCwd: string

beforeEach(async () => {
    originalCwd = process.cwd()
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'engine-installer-test-')))
    // engine-installer reads the bundle from `dist/packages/engine/main.js` relative to the cwd,
    // the way the worker runs inside the image.
    process.chdir(tempDir)
    await writeEngineBundle({ content: 'engine-build-1' })
})

afterEach(async () => {
    process.chdir(originalCwd)
    vi.doUnmock('../../../src/lib/config/worker-settings')
    await rm(tempDir, { recursive: true, force: true })
})

describe('engineInstaller.install (#586)', () => {
    it('is a cache hit after a restart of the same image', async () => {
        expect(await installInFreshProcess()).toEqual({ cacheHit: false })
        expect(await installInFreshProcess()).toEqual({ cacheHit: true })
    })

    it('misses and copies the new engine when the image ships a different bundle', async () => {
        await installInFreshProcess()

        await writeEngineBundle({ content: 'engine-build-2' })
        expect(await installInFreshProcess()).toEqual({ cacheHit: false })
        expect(await readFile(join(commonPath(), 'main.js'), 'utf8')).toBe('engine-build-2')
    })
})

// A worker restart starts with empty module state: no in-memory cache, no memoised engine id.
async function installInFreshProcess(): Promise<{ cacheHit: boolean }> {
    vi.resetModules()
    vi.doMock('../../../src/lib/config/worker-settings', () => ({
        workerSettings: { getSettings: () => ({ ENVIRONMENT: ApEnvironment.PRODUCTION }) },
    }))
    const { engineInstaller } = await import('../../../src/lib/cache/engine/engine-installer')
    return engineInstaller(pino({ level: 'silent' })).install({ path: commonPath() })
}

async function writeEngineBundle({ content }: { content: string }): Promise<void> {
    const engineDir = join(tempDir, 'dist', 'packages', 'engine')
    await mkdir(engineDir, { recursive: true })
    await writeFile(join(engineDir, 'main.js'), content)
    await writeFile(join(engineDir, 'main.js.map'), '{}')
}

function commonPath(): string {
    return join(tempDir, 'cache', 'common')
}
