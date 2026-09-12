import fs from 'fs/promises'
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
