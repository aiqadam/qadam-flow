import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
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
let renameHook: (params: { from: string, to: string }) => Promise<void>
let rmHook: (target: string) => Promise<void>

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'code-builder-test-')))
    buildHook = async () => undefined
    installShouldFail = false
    renameHook = async () => undefined
    rmHook = async () => undefined
    vi.resetModules()
    // Pass-through, with hooks for the filesystem failures a shared volume can produce mid-swap.
    vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
            ...actual,
            default: actual,
            rename: async (from: string, to: string) => {
                await renameHook({ from: String(from), to: String(to) })
                return actual.rename(from, to)
            },
            rm: async (target: string, options?: { recursive?: boolean, force?: boolean }) => {
                await rmHook(String(target))
                return actual.rm(target, options)
            },
        }
    })
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
    vi.doUnmock('node:fs/promises')
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

    it('puts the previous build back when the new one cannot be renamed into place', async () => {
        await processStep({ code: 'version-1' })

        renameHook = async ({ from, to }) => {
            if (from.includes('.build-') && to === stepPath()) {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
            }
        }
        await expect(processStep({ code: 'version-2' })).rejects.toThrow('permission denied')

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-1')
        expect(await readdir(flowVersionPath())).toEqual([STEP_NAME])
    })

    it('keeps a good build when the retired one cannot be deleted', async () => {
        await processStep({ code: 'version-1' })

        rmHook = async (target) => {
            if (target.includes('.retired-')) {
                throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
            }
        }
        await processStep({ code: 'version-2' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-2')
    })

    it('keeps another replica\'s build that was swapped in between its two renames', async () => {
        await processStep({ code: 'version-1' })

        renameHook = async ({ from, to }) => {
            if (from.includes('.build-') && to === stepPath()) {
                await mkdir(stepPath(), { recursive: true })
                await writeFile(stepIndexPath(), 'other-replica')
            }
        }
        await processStep({ code: 'version-2' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('other-replica')
        expect(await readdir(flowVersionPath())).toEqual([STEP_NAME])
    })

    it('removes build directories older than any build can run, and keeps younger ones', async () => {
        const stale = join(flowVersionPath(), `${STEP_NAME}.build-stale`)
        const inProgress = join(flowVersionPath(), `${STEP_NAME}.build-in-progress`)
        const otherStep = join(flowVersionPath(), `${STEP_NAME}0.build-stale`)
        await mkdir(stale, { recursive: true })
        await mkdir(inProgress, { recursive: true })
        await mkdir(otherStep, { recursive: true })
        const anHourAgo = new Date(Date.now() - 60 * 60 * 1000)
        await utimes(stale, anHourAgo, anHourAgo)
        await utimes(otherStep, anHourAgo, anHourAgo)

        await processStep({ code: 'version-1' })

        expect((await readdir(flowVersionPath())).sort()).toEqual([
            STEP_NAME,
            `${STEP_NAME}.build-in-progress`,
            `${STEP_NAME}0.build-stale`,
        ])
    })
})

function flowVersionPath(): string {
    return join(tempDir, 'codes', FLOW_VERSION_ID)
}

function stepPath(): string {
    return join(flowVersionPath(), STEP_NAME)
}

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
