import { copyFile, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionMode, FlowVersionState } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FLOW_VERSION_ID = 'flow-version-1'
const STEP_NAME = 'step_1'

let tempDir: string
let buildHook: () => Promise<void>
let installShouldFail: boolean

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'code-builder-test-')))
    buildHook = async () => undefined
    installShouldFail = false
    vi.resetModules()
    vi.doMock('../../../src/lib/config/worker-settings', () => ({
        workerSettings: { getSettings: () => ({ EXECUTION_MODE: ExecutionMode.UNSANDBOXED }) },
    }))
    // Stands in for bun + esbuild: the "bundle" is the source itself, so a test can tell builds apart.
    vi.doMock('../../../src/lib/cache/code/bun-runner', () => ({
        bunRunner: () => ({
            install: async () => {
                if (installShouldFail) {
                    throw new Error('bun install failed')
                }
                return { stdout: '', stderr: '' }
            },
            build: async ({ entryFile, outputFile }: { entryFile: string, outputFile: string }) => {
                await buildHook()
                await copyFile(entryFile, outputFile)
                return { stdout: '', stderr: '' }
            },
        }),
    }))
})

afterEach(async () => {
    vi.doUnmock('../../../src/lib/config/worker-settings')
    vi.doUnmock('../../../src/lib/cache/code/bun-runner')
    await rm(tempDir, { recursive: true, force: true })
})

describe('codeBuilder.processCodeStep (#586)', () => {
    it('keeps the previous build readable at the step path while a changed step rebuilds', async () => {
        await processStep({ code: 'version-1' })

        const seenDuringRebuild: string[] = []
        buildHook = async () => {
            seenDuringRebuild.push(await readFile(stepIndexPath(), 'utf8'))
        }
        await processStep({ code: 'version-2' })

        expect(seenDuringRebuild).toEqual(['version-1'])
        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-2')
    })

    it('leaves only the step directory behind after a rebuild: no build or retired directory, no lock', async () => {
        await processStep({ code: 'version-1' })
        await processStep({ code: 'version-2' })

        expect(await readdir(join(tempDir, 'codes', FLOW_VERSION_ID))).toEqual([STEP_NAME])
        expect(await readdir(join(tempDir, 'codes', FLOW_VERSION_ID, STEP_NAME))).not.toContain('node_modules')
    })

    it('keeps the previous build and cleans up when a rebuild fails', async () => {
        await processStep({ code: 'version-1' })

        installShouldFail = true
        await expect(processStep({ code: 'version-2' })).rejects.toThrow('bun install failed')

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-1')
        expect(await readdir(join(tempDir, 'codes', FLOW_VERSION_ID))).toEqual([STEP_NAME])
    })
})

async function processStep({ code }: { code: string }): Promise<void> {
    const { codeBuilder } = await import('../../../src/lib/cache/code/code-builder')
    await codeBuilder(pino({ level: 'silent' })).processCodeStep({
        codesFolderPath: join(tempDir, 'codes'),
        artifact: {
            name: STEP_NAME,
            flowVersionId: FLOW_VERSION_ID,
            flowVersionState: FlowVersionState.LOCKED,
            sourceCode: { code, packageJson: '{}' },
        },
    })
}

function stepIndexPath(): string {
    return join(tempDir, 'codes', FLOW_VERSION_ID, STEP_NAME, 'index.js')
}
