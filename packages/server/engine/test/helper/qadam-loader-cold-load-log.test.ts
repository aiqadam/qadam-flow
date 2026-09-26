import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'

const SUBFLOWS_NAME = '@aiqadam/qadam-subflows'
const DELAY_NAME = '@aiqadam/qadam-delay'

describe('qadamLoader.loadQadamOrThrow — cold-load logging (#419 Phase 0)', () => {
    let subflowsVersion: string
    let delayVersion: string
    let consoleLogSpy: ReturnType<typeof vi.spyOn>

    beforeAll(async () => {
        subflowsVersion = await readPackageVersion('packages/qadams/core/subflows/package.json')
        delayVersion = await readPackageVersion('packages/qadams/core/delay/package.json')
    })

    beforeEach(() => {
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('logs one structured line on the first (cold) load of a qadam and none on a repeat (warm) load', async () => {
        await qadamLoader.loadQadamOrThrow({ qadamName: SUBFLOWS_NAME, qadamVersion: subflowsVersion, devQadams: [] })

        const firstLoadLogs = coldLoadLogLines(consoleLogSpy)
        expect(firstLoadLogs).toHaveLength(1)
        const firstLine = parseColdLoadLine(firstLoadLogs[0])
        expect(firstLine.qadam).toBe(`${SUBFLOWS_NAME}@${subflowsVersion}`)
        expect(firstLine.resolvedVersion).toBe(subflowsVersion)
        expect(typeof firstLine.resolveMs).toBe('number')
        expect(typeof firstLine.importMs).toBe('number')
        // The very first qadam a fresh process loads has not pulled the shared framework
        // dist in through anyone else's `require` yet.
        expect(firstLine.sharedDepsAlreadyLoaded).toBe(false)

        consoleLogSpy.mockClear()
        await qadamLoader.loadQadamOrThrow({ qadamName: SUBFLOWS_NAME, qadamVersion: subflowsVersion, devQadams: [] })

        expect(coldLoadLogLines(consoleLogSpy)).toHaveLength(0)
    })

    it('reports sharedDepsAlreadyLoaded=true for a second, different qadam once the first one pulled it in', async () => {
        await qadamLoader.loadQadamOrThrow({ qadamName: SUBFLOWS_NAME, qadamVersion: subflowsVersion, devQadams: [] })
        consoleLogSpy.mockClear()

        await qadamLoader.loadQadamOrThrow({ qadamName: DELAY_NAME, qadamVersion: delayVersion, devQadams: [] })

        const logs = coldLoadLogLines(consoleLogSpy)
        expect(logs).toHaveLength(1)
        const line = parseColdLoadLine(logs[0])
        expect(line.qadam).toBe(`${DELAY_NAME}@${delayVersion}`)
        expect(line.resolvedVersion).toBe(delayVersion)
        expect(line.sharedDepsAlreadyLoaded).toBe(true)
    })

    // #419 review: a failed cold import must not log a cold-load line, and must not leave the path
    // permanently marked "seen" in `loggedColdQadamPaths` (verified by reading the source: the
    // `import()` line is wrapped so a throw un-marks the path before rethrowing). Whether a retry
    // can actually reach a fresh, successful import of the exact same path depends on *why* the
    // first attempt failed: Node caches a failure that happens during evaluation (a runtime
    // `throw`, a `SyntaxError`) at the resolved-specifier level for the process's lifetime — a
    // second `import()` of that exact path rejects with the *original* error even after the file on
    // disk is fixed, confirmed against plain Node (no bundler, no vitest). But plain Node does
    // *not* cache `ERR_MODULE_NOT_FOUND` — e.g. a half-written install where the qadam's directory
    // already exists but its entry file is still being written appears a moment later — and there
    // the Set cleanup is exactly what lets that later, genuinely successful import get its own
    // cold-load line. That specific case can't be exercised in *this* test harness, though: vitest's
    // vite-node loader caches both kinds of failure (confirmed the same way), so no fix-dependent
    // end-to-end test is possible here — only that a failed attempt logs nothing, which holds either
    // way and is what the test below covers.
    describe('a failed import does not log a cold-load line', () => {
        const qadamName = '@aiqadam/qadam-419-throws-on-import'
        const qadamVersion = '0.0.1'
        let workspace: string
        let previousCustomPaths: string | undefined

        beforeEach(async () => {
            workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qadam-loader-cold-log-'))
            previousCustomPaths = process.env.AP_CUSTOM_PIECES_PATHS
            process.env.AP_CUSTOM_PIECES_PATHS = workspace

            const alias = `${qadamName}-${qadamVersion}`
            const installedDir = path.join(workspace, 'qadams', alias, 'node_modules', qadamName)
            await fs.mkdir(path.join(installedDir, 'src'), { recursive: true })
            await fs.writeFile(path.join(installedDir, 'src', 'index.js'), 'throw new Error(\'boom\')\n')
        })

        afterEach(async () => {
            if (previousCustomPaths === undefined) {
                delete process.env.AP_CUSTOM_PIECES_PATHS
            }
            else {
                process.env.AP_CUSTOM_PIECES_PATHS = previousCustomPaths
            }
            await fs.rm(workspace, { recursive: true, force: true })
        })

        it('logs nothing when the import throws', async () => {
            await expect(qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams: [] })).rejects.toThrow('boom')
            expect(coldLoadLogLines(consoleLogSpy)).toHaveLength(0)
        })
    })

    describe('resolvedVersion is read from the resolved package\'s own package.json', () => {
        let workspace: string
        let previousCustomPaths: string | undefined

        beforeEach(async () => {
            workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qadam-loader-cold-log-'))
            previousCustomPaths = process.env.AP_CUSTOM_PIECES_PATHS
            process.env.AP_CUSTOM_PIECES_PATHS = workspace
        })

        afterEach(async () => {
            if (previousCustomPaths === undefined) {
                delete process.env.AP_CUSTOM_PIECES_PATHS
            }
            else {
                process.env.AP_CUSTOM_PIECES_PATHS = previousCustomPaths
            }
            await fs.rm(workspace, { recursive: true, force: true })
        })

        it('reports the version from the installed package\'s own package.json, not the requested one', async () => {
            const qadamName = '@aiqadam/qadam-419-resolved-version'
            const qadamVersion = '0.0.1'
            const installedDir = await installFixture({ workspace, qadamName, qadamVersion })
            await fs.writeFile(path.join(installedDir, 'package.json'), JSON.stringify({ version: '0.0.2' }))

            await expect(qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams: [] })).rejects.toThrow()

            const logs = coldLoadLogLines(consoleLogSpy)
            expect(logs).toHaveLength(1)
            const line = parseColdLoadLine(logs[0])
            expect(line.qadam).toBe(`${qadamName}@${qadamVersion}`)
            expect(line.resolvedVersion).toBe('0.0.2')
        })

        it('reports resolvedVersion=null when the installed package has no package.json', async () => {
            const qadamName = '@aiqadam/qadam-419-resolved-version-missing'
            const qadamVersion = '0.0.1'
            await installFixture({ workspace, qadamName, qadamVersion })
            // Deliberately no package.json written next to `src/index.js`.

            await expect(qadamLoader.loadQadamOrThrow({ qadamName, qadamVersion, devQadams: [] })).rejects.toThrow()

            const logs = coldLoadLogLines(consoleLogSpy)
            expect(logs).toHaveLength(1)
            expect(parseColdLoadLine(logs[0]).resolvedVersion).toBeNull()
        })
    })
})

// Lays out `<workspace>/qadams/<name>-<version>/node_modules/<name>/src/index.js` — the shape
// `traverseAllParentFoldersToFindQadam` resolves via `AP_CUSTOM_PIECES_PATHS` — and returns the
// installed package's own root directory (the sibling of `src`, where `package.json` belongs).
async function installFixture({ workspace, qadamName, qadamVersion }: InstallFixtureParams): Promise<string> {
    const alias = `${qadamName}-${qadamVersion}`
    const installedDir = path.join(workspace, 'qadams', alias, 'node_modules', qadamName)
    await fs.mkdir(path.join(installedDir, 'src'), { recursive: true })
    // Exports nothing `extractQadamFromModule` recognises, so the call rejects after the cold-load
    // line is logged — these tests only care about what got logged, not about a full successful load.
    await fs.writeFile(path.join(installedDir, 'src', 'index.js'), 'module.exports = {}\n')
    return installedDir
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
    const parsed: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
        throw new Error(`${packageJsonPath} has no version`)
    }
    return parsed.version
}

function coldLoadLogLines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
        .map(([line]: unknown[]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('[qadamLoader] cold load '))
}

function parseColdLoadLine(line: string): ColdLoadLogLine {
    const parsed: unknown = JSON.parse(line.slice('[qadamLoader] cold load '.length))
    if (
        typeof parsed !== 'object' || parsed === null
        || !('qadam' in parsed) || typeof parsed.qadam !== 'string'
        || !('resolvedVersion' in parsed) || (typeof parsed.resolvedVersion !== 'string' && parsed.resolvedVersion !== null)
        || !('resolveMs' in parsed) || typeof parsed.resolveMs !== 'number'
        || !('importMs' in parsed) || typeof parsed.importMs !== 'number'
        || !('sharedDepsAlreadyLoaded' in parsed) || typeof parsed.sharedDepsAlreadyLoaded !== 'boolean'
    ) {
        throw new Error(`Unexpected cold-load log shape: ${line}`)
    }
    return parsed
}

type ColdLoadLogLine = {
    qadam: string
    resolvedVersion: string | null
    resolveMs: number
    importMs: number
    sharedDepsAlreadyLoaded: boolean
}

type InstallFixtureParams = {
    workspace: string
    qadamName: string
    qadamVersion: string
}
