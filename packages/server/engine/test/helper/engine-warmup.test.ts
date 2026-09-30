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
        const write = vi.fn()
        const requireFromQadam = createRequire(indexPath)
        expect(requireFromQadam.cache[frameworkEntry]).toBeUndefined()

        await engineWarmup.run({ write })

        expect(getDistIndexMock).toHaveBeenCalledWith({ refresh: false })
        expect(requireFromQadam.cache[frameworkEntry]).toBeDefined()
        expect(write).toHaveBeenCalledTimes(1)
        const line = String(write.mock.calls[0][0])
        expect(line.startsWith('[engineWarmup] done ')).toBe(true)
        const payload: unknown = JSON.parse(line.slice('[engineWarmup] done '.length))
        // qadams-common is absent from the fixture, and a dependency that does not resolve is skipped.
        expect(payload).toMatchObject({ qadams: 1, sharedDeps: ['@aiqadam/qadams-framework'] })
    })

    // The engine's console is patched to also feed the notify channel, which is captured into the
    // running job's logs; the warmup can overlap the first job, so its line must bypass it.
    it('writes only to the sink it is given, never to the console', async () => {
        getDistIndexMock.mockResolvedValue(new Map())
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const write = vi.fn()

        await engineWarmup.run({ write })
        getDistIndexMock.mockRejectedValue(new Error('EACCES'))
        await engineWarmup.run({ write })

        expect(write).toHaveBeenCalledTimes(2)
        expect(logSpy).not.toHaveBeenCalled()
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it('never throws when the dist index cannot be built — the first job just pays the cost', async () => {
        getDistIndexMock.mockRejectedValue(new Error('EACCES'))
        const write = vi.fn()

        await expect(engineWarmup.run({ write })).resolves.toBeUndefined()

        expect(write).toHaveBeenCalledWith(expect.stringContaining('[engineWarmup] skipped'))
        expect(write).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
    })

    it('loads nothing when there is no bundled qadam to resolve through', async () => {
        getDistIndexMock.mockResolvedValue(new Map())
        const write = vi.fn()

        await engineWarmup.run({ write })

        expect(write).toHaveBeenCalledWith(expect.stringContaining('"sharedDeps":[]'))
    })
})
