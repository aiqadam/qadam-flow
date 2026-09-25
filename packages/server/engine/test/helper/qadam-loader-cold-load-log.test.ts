import fs from 'fs/promises'
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
        expect(typeof firstLine.resolveMs).toBe('number')
        expect(typeof firstLine.importMs).toBe('number')
        expect(typeof firstLine.executionMode).toBe('string')
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
        expect(line.sharedDepsAlreadyLoaded).toBe(true)
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
        || !('resolveMs' in parsed) || typeof parsed.resolveMs !== 'number'
        || !('importMs' in parsed) || typeof parsed.importMs !== 'number'
        || !('sharedDepsAlreadyLoaded' in parsed) || typeof parsed.sharedDepsAlreadyLoaded !== 'boolean'
        || !('executionMode' in parsed) || typeof parsed.executionMode !== 'string'
    ) {
        throw new Error(`Unexpected cold-load log shape: ${line}`)
    }
    return parsed
}

type ColdLoadLogLine = {
    qadam: string
    resolveMs: number
    importMs: number
    sharedDepsAlreadyLoaded: boolean
    executionMode: string
}
