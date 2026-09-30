import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { engineWarmup } from '../../src/lib/helper/engine-warmup'

// #419: the real dist index, not a mock. A manifest the warmup rejects must say so through the
// warmup's own writer: the engine's patched console also feeds the notify channel, so a warning
// written there while the first job runs would land in that job's log.
describe('engineWarmup with a rejected manifest (#419)', () => {
    let appRoot: string

    beforeEach(async () => {
        appRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-warmup-manifest-')))
        const distDir = path.join(appRoot, 'packages', 'qadams', 'core', 'alpha', 'dist')
        await fs.mkdir(path.join(distDir, 'src'), { recursive: true })
        await fs.writeFile(path.join(distDir, 'package.json'), JSON.stringify({ name: '@aiqadam/qadam-alpha', version: '1.0.0' }))
        await fs.writeFile(path.join(distDir, 'src', 'index.js'), 'module.exports = {}\n')
        await fs.writeFile(path.join(appRoot, 'packages', 'qadams', 'dist-index.json'), JSON.stringify({ version: 2, entries: [] }))
        vi.spyOn(process, 'cwd').mockReturnValue(appRoot)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(appRoot, { recursive: true, force: true })
    })

    it('reports the rejection through its writer, never the console, and still scans', async () => {
        const warnSpy = vi.spyOn(console, 'warn')
        const lines: string[] = []

        await engineWarmup.run({ write: (line) => lines.push(line) })

        expect(lines[0]).toBe('[qadamDistIndex] manifest rejected, scanning instead {"reason":"not a version-1 manifest"}')
        expect(lines[1]).toContain('"qadams":1')
        expect(warnSpy).not.toHaveBeenCalled()
    })
})
