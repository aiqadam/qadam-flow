import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'

const BUNDLED_QADAM_ALIAS = '@aiqadam/qadam-subflows-0.0.1'
const DEV_QADAM_PACKAGE = '@aiqadam/qadam-http'
const VERSIONED_QADAM_ALIAS = '@aiqadam/qadam-http-0.0.1'
const DEV_QADAMS = ['http']

describe('qadamLoader.getQadamPath', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('should not re-scan the dist tree when the same qadam is resolved again', async () => {
        const firstPath = await qadamLoader.getQadamPath({ packageName: BUNDLED_QADAM_ALIAS, devQadams: [] })
        expect(firstPath).toContain('subflows')

        const readdirSpy = vi.spyOn(fs, 'readdir')
        const accessSpy = vi.spyOn(fs, 'access')
        const secondPath = await qadamLoader.getQadamPath({ packageName: BUNDLED_QADAM_ALIAS, devQadams: [] })

        expect(secondPath).toBe(firstPath)
        expect(readdirSpy).not.toHaveBeenCalled()
        expect(accessSpy).not.toHaveBeenCalled()
    })

    it('should not scan the dist tree for a qadam already indexed by an earlier lookup', async () => {
        await qadamLoader.getQadamPath({ packageName: BUNDLED_QADAM_ALIAS, devQadams: [] })

        const readdirSpy = vi.spyOn(fs, 'readdir')
        const resolvedPath = await qadamLoader.getQadamPath({ packageName: VERSIONED_QADAM_ALIAS, devQadams: [] })

        expect(resolvedPath).toContain('http')
        expect(readdirSpy).not.toHaveBeenCalled()
    })

    it('should re-read the dist tree on every lookup of a dev qadam', async () => {
        await qadamLoader.getQadamPath({ packageName: DEV_QADAM_PACKAGE, devQadams: DEV_QADAMS })

        const readdirSpy = vi.spyOn(fs, 'readdir')
        await qadamLoader.getQadamPath({ packageName: DEV_QADAM_PACKAGE, devQadams: DEV_QADAMS })

        expect(readdirSpy).toHaveBeenCalled()
    })

    it('should not cache a failed resolution', async () => {
        const packageName = '@aiqadam/qadam-does-not-exist-0.0.1'
        await expect(qadamLoader.getQadamPath({ packageName, devQadams: [] })).rejects.toThrow('Qadam not found')

        const accessSpy = vi.spyOn(fs, 'access')
        await expect(qadamLoader.getQadamPath({ packageName, devQadams: [] })).rejects.toThrow('Qadam not found')

        expect(accessSpy).toHaveBeenCalled()
    })
})

// #503: in the default UNSANDBOXED mode a CUSTOM qadam a platform registered under an official
// name installs into the workspace every tenant shares, and the loader used to prefer that
// installed copy over the bundled build. `AP_CUSTOM_PIECES_PATHS` is the first place the
// installed-copy walk looks, so a temp dir there stands in for the shared workspace.
describe('qadamLoader.getQadamPath — installed copy under a bundled name (#503)', () => {
    const BUNDLED_NAME = '@aiqadam/qadam-subflows'
    let bundledVersion: string
    let workspace: string
    let previousCustomPaths: string | undefined

    beforeAll(async () => {
        const packageJson: unknown = JSON.parse(await fs.readFile('packages/qadams/core/subflows/package.json', 'utf-8'))
        if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson) || typeof packageJson.version !== 'string') {
            throw new Error('subflows package.json has no version')
        }
        bundledVersion = packageJson.version
    })

    beforeEach(async () => {
        workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qadam-loader-503-'))
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

    async function installCopy(alias: string): Promise<string> {
        const installedDir = path.join(workspace, 'qadams', alias, 'node_modules', BUNDLED_NAME)
        await fs.mkdir(path.join(installedDir, 'src'), { recursive: true })
        await fs.writeFile(path.join(installedDir, 'src', 'index.js'), 'module.exports = {}\n')
        return path.join(installedDir, 'src', 'index.js')
    }

    it('should prefer the bundled build over an installed copy at the same name@version', async () => {
        const alias = `${BUNDLED_NAME}-${bundledVersion}`
        const installedIndex = await installCopy(alias)

        const resolvedPath = await qadamLoader.getQadamPath({ packageName: alias, devQadams: [] })

        expect(resolvedPath).not.toBe(installedIndex)
        expect(resolvedPath).toContain(path.join('packages', 'qadams', 'core', 'subflows', 'dist'))
    })

    it('should still resolve an installed copy at a version the bundled build does not carry', async () => {
        const alias = `${BUNDLED_NAME}-9.9.9`
        const installedIndex = await installCopy(alias)

        const resolvedPath = await qadamLoader.getQadamPath({ packageName: alias, devQadams: [] })

        expect(resolvedPath).toBe(installedIndex)
    })
})
