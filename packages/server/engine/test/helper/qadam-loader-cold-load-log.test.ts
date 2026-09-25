import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'

const SUBFLOWS_NAME = '@aiqadam/qadam-subflows'
const TABLES_NAME = '@aiqadam/qadam-tables'

describe('qadamLoader.loadQadamOrThrow — cold-load logging (#419 Phase 0)', () => {
    let subflowsVersion: string
    let tablesVersion: string
    let consoleLogSpy: ReturnType<typeof vi.spyOn>

    beforeAll(async () => {
        subflowsVersion = await readPackageVersion('packages/qadams/core/subflows/package.json')
        tablesVersion = await readPackageVersion('packages/qadams/core/tables/package.json')
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

        await qadamLoader.loadQadamOrThrow({ qadamName: TABLES_NAME, qadamVersion: tablesVersion, devQadams: [] })

        const logs = coldLoadLogLines(consoleLogSpy)
        expect(logs).toHaveLength(1)
        const line = parseColdLoadLine(logs[0])
        expect(line.qadam).toBe(`${TABLES_NAME}@${tablesVersion}`)
        expect(line.resolvedVersion).toBe(tablesVersion)
        expect(line.sharedDepsAlreadyLoaded).toBe(true)
    })

    // #419 review: a failed cold import must not log a cold-load line, and must not leave the path
    // permanently marked "seen" in `loggedColdQadamPaths` (verified by reading the source: the
    // `import()` line is wrapped so a throw un-marks the path before rethrowing). A genuine
    // "retry succeeds this time" case cannot be exercised end-to-end here: Node's dynamic `import()`
    // caches a failure at the resolved-specifier level for the lifetime of the process — a second
    // `import()` of the *exact same* path rejects with the *original* error even after the file on
    // disk is fixed, confirmed against plain Node (no bundler, no vitest) for both a runtime `throw`
    // and a `SyntaxError`. So the Set cleanup is real bookkeeping hygiene, but an end-to-end test
    // that reuses the same failed path can only ever assert "still no log line" — true regardless of
    // whether the cleanup ran, so it would pass for the wrong reason and is not included here.
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
})

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
