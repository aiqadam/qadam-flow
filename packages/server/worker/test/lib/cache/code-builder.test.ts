import { access, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionMode, FlowVersionState } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FLOW_VERSION_ID = 'flow-version-1'
const STEP_NAME = 'step_1'
const SOURCE_HASH_FILE = '.source-hash'

let tempDir: string
let buildHook: () => Promise<void>
let installShouldFail: boolean
let compileShouldFail: boolean
let renameHook: (params: { from: string, to: string }) => Promise<void>
let rmHook: (target: string) => Promise<void>
let readFileHook: (target: string) => Promise<void>

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'code-builder-test-')))
    buildHook = async () => undefined
    installShouldFail = false
    compileShouldFail = false
    renameHook = async () => undefined
    rmHook = async () => undefined
    readFileHook = async () => undefined
    vi.resetModules()
    // Pass-through, with hooks for the filesystem failures a shared volume can produce mid-swap.
    vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        // The builder reads `.source-hash` through the default export, so the hook goes there.
        const readFileWithHook = async (...args: Parameters<typeof actual.readFile>) => {
            await readFileHook(String(args[0]))
            return actual.readFile(...args)
        }
        return {
            ...actual,
            default: { ...actual, readFile: readFileWithHook },
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
                if (compileShouldFail) {
                    throw Object.assign(new Error('esbuild failed'), { stdout: `${entryFile}:1:0: ERROR: Unexpected end of file` })
                }
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

// Each test re-imports the builder's whole module graph after vi.resetModules, which under a
// loaded machine (the pre-push gate runs every package's suite at once) can outlast the 5 s default.
describe('codeBuilder.processCodeStep (#586)', { timeout: 30_000 }, () => {
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

    it('keeps another replica\'s build of the same source that was swapped in between its two renames', async () => {
        await processStep({ code: 'version-1' })

        renameHook = onceBeforeSwap(async ({ from }) => {
            await writeOtherReplicaBuild({ code: 'other-replica', sourceHash: await readFile(join(from, SOURCE_HASH_FILE), 'utf8') })
        })
        await processStep({ code: 'version-2' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('other-replica')
        expect(await readdir(flowVersionPath())).toEqual([STEP_NAME])
    })

    it('replaces another replica\'s build of a different source that was swapped in between its two renames', async () => {
        await processStep({ code: 'version-1' })

        renameHook = onceBeforeSwap(async () => {
            await writeOtherReplicaBuild({ code: 'other-replica', sourceHash: 'hash-of-an-older-source' })
        })
        await processStep({ code: 'version-2' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-2')
        expect(await readdir(flowVersionPath())).toEqual([STEP_NAME])
    })

    it('gives up, and cleans up, when other replicas keep replacing the step with a different source', async () => {
        await processStep({ code: 'version-1' })

        renameHook = async ({ from, to }) => {
            if (from.includes('.build-') && to === stepPath()) {
                await writeOtherReplicaBuild({ code: 'other-replica', sourceHash: 'hash-of-an-older-source' })
            }
        }
        await expect(processStep({ code: 'version-2' })).rejects.toThrow('other replicas kept replacing it')

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('other-replica')
        expect(await readdir(flowVersionPath())).toEqual([STEP_NAME])
    })

    it('rebuilds when the step directory holds a build of another source than cache.json and memory record', async () => {
        await processStep({ code: 'version-1' })
        // What a lock-timeout fallback can leave: another replica swapped its build in after this
        // replica's, and this replica's hash was saved into the other build's cache.json.
        await writeOtherReplicaBuild({ code: 'other-replica', sourceHash: 'hash-of-another-source' })

        await processStep({ code: 'version-1' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-1')
    })

    it('trusts cache.json for a build from before source hashes, instead of rebuilding every step once', async () => {
        await processStep({ code: 'version-1' })
        await rm(join(stepPath(), SOURCE_HASH_FILE))
        await writeFile(stepIndexPath(), 'built-before-586')

        await processStep({ code: 'version-1' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('built-before-586')
    })

    // The step directory can be swapped between the builder's first `.source-hash` read and its
    // check that the directory exists: another replica retired the build this replica recorded and
    // renamed its own in. Only the re-read tells that apart from a build from before #586 (#593).
    it('rebuilds when .source-hash is missing on the first read and names another source on the re-read', async () => {
        await processStep({ code: 'version-1' })

        let sourceHashReads = 0
        readFileHook = async (target) => {
            if (!target.endsWith(SOURCE_HASH_FILE)) {
                return
            }
            sourceHashReads++
            if (sourceHashReads === 1) {
                await writeOtherReplicaBuild({ code: 'other-replica', sourceHash: 'hash-of-another-source' })
                throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
            }
        }
        await processStep({ code: 'version-1' })

        expect(sourceHashReads).toBeGreaterThanOrEqual(2)
        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-1')
    })

    it('rebuilds a step whose directory is gone, although memory still records it as built', async () => {
        await processStep({ code: 'version-1' })
        await rm(stepPath(), { recursive: true, force: true })

        await processStep({ code: 'version-1' })

        expect(await readFile(stepIndexPath(), 'utf8')).toBe('version-1')
    })

    it('builds under the cross-container lock', async () => {
        const lockHeldDuringBuild: boolean[] = []
        buildHook = async () => {
            lockHeldDuringBuild.push(await access(`${stepPath()}.cache-state.lock`).then(() => true, () => false))
        }

        await processStep({ code: 'version-1' })

        expect(lockHeldDuringBuild).toEqual([true])
    })

    it('reports a compilation error against the step path, not the build directory', async () => {
        compileShouldFail = true

        await processStep({ code: 'broken(' })

        const artifact = await readFile(stepIndexPath(), 'utf8')
        expect(artifact).toContain(`${stepPath()}/index.ts:1:0`)
        expect(artifact).not.toContain('.build-')
    })

    it('ages build directories by the time in their name, not their mtime, which a rename does not update', async () => {
        const anHourAgo = Date.now() - 60 * 60 * 1000
        const stale = `${STEP_NAME}.build-${anHourAgo}-a`
        const staleRetired = `${STEP_NAME}.retired-${anHourAgo}-b`
        const inProgress = `${STEP_NAME}.build-${Date.now()}-c`
        const justRetired = `${STEP_NAME}.retired-${Date.now()}-d`
        const withoutTime = `${STEP_NAME}.build-no-time`
        const otherStep = `${STEP_NAME}0.build-${anHourAgo}-e`
        const oldMtime = new Date(anHourAgo)
        for (const entry of [stale, staleRetired, inProgress, justRetired, withoutTime, otherStep]) {
            await mkdir(join(flowVersionPath(), entry), { recursive: true })
            await utimes(join(flowVersionPath(), entry), oldMtime, oldMtime)
        }

        await processStep({ code: 'version-1' })

        expect((await readdir(flowVersionPath())).sort()).toEqual([STEP_NAME, otherStep, inProgress, justRetired, withoutTime].sort())
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

// Stands in for another replica that swaps its own build in while this one is between renames.
function onceBeforeSwap(hook: (params: { from: string }) => Promise<void>): (params: { from: string, to: string }) => Promise<void> {
    let fired = false
    return async ({ from, to }) => {
        if (!fired && from.includes('.build-') && to === stepPath()) {
            fired = true
            await hook({ from })
        }
    }
}

async function writeOtherReplicaBuild({ code, sourceHash }: { code: string, sourceHash: string }): Promise<void> {
    await mkdir(stepPath(), { recursive: true })
    await writeFile(stepIndexPath(), code)
    await writeFile(join(stepPath(), SOURCE_HASH_FILE), sourceHash)
}

function stepIndexPath(): string {
    return join(tempDir, 'codes', FLOW_VERSION_ID, STEP_NAME, 'index.js')
}
