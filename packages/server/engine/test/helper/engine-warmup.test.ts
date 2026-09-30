import fs from 'fs/promises'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'

const { getDistIndexMock } = vi.hoisted(() => ({ getDistIndexMock: vi.fn() }))

vi.mock('../../src/lib/helper/qadam-dist-index', () => ({
    qadamDistIndex: { get: getDistIndexMock },
}))

import { engineWarmup } from '../../src/lib/helper/engine-warmup'

// #419: a bundled qadam whose own `node_modules` carries a stand-in framework, the way bun lays out
// `packages/qadams/core/<qadam>/node_modules/@aiqadam/qadams-framework` in the image.
async function buildQadamWithFramework(root: string): Promise<{ indexPath: string, frameworkEntry: string }> {
    const qadamDir = path.join(root, 'core', 'alpha')
    const indexPath = path.join(qadamDir, 'dist', 'src', 'index.js')
    const frameworkDir = path.join(qadamDir, 'node_modules', '@aiqadam', 'qadams-framework')
    await fs.mkdir(path.dirname(indexPath), { recursive: true })
    await fs.mkdir(frameworkDir, { recursive: true })
    await fs.writeFile(indexPath, 'module.exports = {}\n')
    await fs.writeFile(path.join(frameworkDir, 'package.json'), JSON.stringify({ name: '@aiqadam/qadams-framework', main: 'index.js' }))
    await fs.writeFile(path.join(frameworkDir, 'index.js'), 'module.exports = { loaded: true }\n')
    return { indexPath, frameworkEntry: path.join(frameworkDir, 'index.js') }
}

describe('engineWarmup (#419)', () => {
    let root: string
    let previousFlag: string | undefined

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-warmup-')))
        previousFlag = process.env.AP_ENGINE_WARMUP
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        getDistIndexMock.mockReset()
        if (previousFlag === undefined) {
            delete process.env.AP_ENGINE_WARMUP
        }
        else {
            process.env.AP_ENGINE_WARMUP = previousFlag
        }
        await fs.rm(root, { recursive: true, force: true })
    })

    it('is enabled only by AP_ENGINE_WARMUP=true', () => {
        delete process.env.AP_ENGINE_WARMUP
        expect(engineWarmup.isEnabled()).toBe(false)
        process.env.AP_ENGINE_WARMUP = 'false'
        expect(engineWarmup.isEnabled()).toBe(false)
        process.env.AP_ENGINE_WARMUP = 'true'
        expect(engineWarmup.isEnabled()).toBe(true)
    })

    it('builds the dist index and loads the framework through a bundled qadam, so the first import finds it cached', async () => {
        const { indexPath, frameworkEntry } = await buildQadamWithFramework(root)
        getDistIndexMock.mockResolvedValue(new Map([['@aiqadam/qadam-alpha', { name: '@aiqadam/qadam-alpha', version: '1.0.0', indexPath }]]))
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const requireFromQadam = createRequire(indexPath)
        expect(requireFromQadam.cache[frameworkEntry]).toBeUndefined()

        await engineWarmup.run()

        expect(getDistIndexMock).toHaveBeenCalledWith({ refresh: false })
        expect(requireFromQadam.cache[frameworkEntry]).toBeDefined()
        const line = logSpy.mock.calls.map((call) => String(call[0])).find((message) => message.startsWith('[engineWarmup] done '))
        expect(line).toBeDefined()
        const payload: unknown = JSON.parse(String(line).slice('[engineWarmup] done '.length))
        // qadams-common is absent from the fixture, and a dependency that does not resolve is skipped.
        expect(payload).toMatchObject({ qadams: 1, sharedDeps: ['@aiqadam/qadams-framework'] })
    })

    it('never throws when the dist index cannot be built — the first job just pays the cost', async () => {
        getDistIndexMock.mockRejectedValue(new Error('EACCES'))
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await expect(engineWarmup.run()).resolves.toBeUndefined()

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[engineWarmup] skipped'))
    })

    it('loads nothing when there is no bundled qadam to resolve through', async () => {
        getDistIndexMock.mockResolvedValue(new Map())
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        await engineWarmup.run()

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sharedDeps":[]'))
    })
})
