import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { QADAM_DIST_MANIFEST_FILE, qadamDistIndex } from '../../src/lib/helper/qadam-dist-index'

// #419: a fixture tree shaped like `packages/qadams` — two built qadams, a duplicate name that the
// scan must drop (first match wins), and the directories the scan must never descend into.
async function buildQadamsTree(root: string): Promise<void> {
    await writeDistPackageJson({ root, dir: 'core/alpha', name: '@aiqadam/qadam-alpha', version: '1.2.3' })
    await writeDistPackageJson({ root, dir: 'community/beta', name: '@aiqadam/qadam-beta', version: null })
    await writeDistPackageJson({ root, dir: 'core/alpha/node_modules/dep', name: '@aiqadam/qadam-in-node-modules', version: '9.9.9' })
    await writeDistPackageJson({ root, dir: 'framework', name: '@aiqadam/qadams-framework', version: '0.1.0' })
}

async function writeDistPackageJson({ root, dir, name, version }: { root: string, dir: string, name: string, version: string | null }): Promise<void> {
    const distDir = path.join(root, dir, 'dist')
    await fs.mkdir(path.join(distDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(distDir, 'package.json'), JSON.stringify(version === null ? { name } : { name, version }))
    await fs.writeFile(path.join(distDir, 'src', 'index.js'), 'module.exports = {}\n')
}

async function writeManifest({ root, content }: { root: string, content: string }): Promise<void> {
    await fs.writeFile(path.join(root, QADAM_DIST_MANIFEST_FILE), content)
}

describe('qadamDistIndex (#419)', () => {
    let root: string

    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qadam-dist-index-')))
        await buildQadamsTree(root)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    it('scans built qadams and skips node_modules and the framework', async () => {
        const index = await qadamDistIndex.load({ qadamsRoot: root, useManifest: false })

        expect([...index.keys()].sort()).toEqual(['@aiqadam/qadam-alpha', '@aiqadam/qadam-beta'])
        expect(index.get('@aiqadam/qadam-alpha')).toEqual({
            name: '@aiqadam/qadam-alpha',
            version: '1.2.3',
            indexPath: path.join(root, 'core/alpha/dist/src/index.js'),
        })
        expect(index.get('@aiqadam/qadam-beta')?.version).toBeNull()
    })

    it('reads a written manifest back to the same index without walking the tree', async () => {
        const scanned = await qadamDistIndex.load({ qadamsRoot: root, useManifest: false })
        const written = await qadamDistIndex.writeManifest({ qadamsRoot: root })
        expect(written).toBe(2)

        const readdirSpy = vi.spyOn(fs, 'readdir')
        const fromManifest = await qadamDistIndex.load({ qadamsRoot: root, useManifest: true })

        expect(readdirSpy).not.toHaveBeenCalled()
        expect([...fromManifest.entries()]).toEqual([...scanned.entries()])
    })

    it('stores index paths relative to the qadams root, so the manifest survives a moved tree', async () => {
        await qadamDistIndex.writeManifest({ qadamsRoot: root })
        const manifest: unknown = JSON.parse(await fs.readFile(path.join(root, QADAM_DIST_MANIFEST_FILE), 'utf-8'))

        expect(JSON.stringify(manifest)).not.toContain(root)
        expect(JSON.stringify(manifest)).toContain(JSON.stringify(path.join('core', 'alpha', 'dist', 'src', 'index.js')))
    })

    it('scans quietly when there is no manifest, as in a dev tree', async () => {
        const readdirSpy = vi.spyOn(fs, 'readdir')
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const index = await qadamDistIndex.load({ qadamsRoot: root, useManifest: true })

        expect(readdirSpy).toHaveBeenCalled()
        expect(index.size).toBe(2)
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it('ignores the manifest when told to scan, as a dev-qadam refresh is', async () => {
        await writeManifest({ root, content: JSON.stringify({ version: 1, entries: [{ name: '@aiqadam/qadam-stale', version: '0.0.1', indexPath: 'core/stale/dist/src/index.js' }] }) })

        const index = await qadamDistIndex.load({ qadamsRoot: root, useManifest: false })

        expect(index.has('@aiqadam/qadam-stale')).toBe(false)
        expect(index.size).toBe(2)
    })

    it.each([
        ['is not JSON', '{not json'],
        ['has an unknown format version', JSON.stringify({ version: 2, entries: [] })],
        ['is empty', JSON.stringify({ version: 1, entries: [] })],
        ['has a malformed entry', JSON.stringify({ version: 1, entries: [{ name: '@aiqadam/qadam-alpha' }] })],
        ['points outside the qadams root', JSON.stringify({ version: 1, entries: [{ name: '@aiqadam/qadam-evil', version: '1.0.0', indexPath: '../../etc/index.js' }] })],
        ['names a qadam whose dist is not there (a stale copy)', JSON.stringify({ version: 1, entries: [{ name: '@aiqadam/qadam-gone', version: '1.0.0', indexPath: 'core/gone/dist/src/index.js' }] })],
    ])('falls back to the scan, and says why, when the manifest %s', async (_case, content) => {
        await writeManifest({ root, content })
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        const index = await qadamDistIndex.load({ qadamsRoot: root, useManifest: true })

        expect([...index.keys()].sort()).toEqual(['@aiqadam/qadam-alpha', '@aiqadam/qadam-beta'])
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[qadamDistIndex] manifest rejected'))
        expect(String(warnSpy.mock.calls[0][0])).not.toContain(root)
    })

    it('keeps the first of two builds with the same name, as the scan always did', async () => {
        await writeDistPackageJson({ root, dir: 'custom/alpha', name: '@aiqadam/qadam-alpha', version: '0.0.1' })
        await writeManifest({
            root,
            content: JSON.stringify({ version: 1, entries: [
                { name: '@aiqadam/qadam-alpha', version: '1.2.3', indexPath: 'core/alpha/dist/src/index.js' },
                { name: '@aiqadam/qadam-alpha', version: '0.0.1', indexPath: 'custom/alpha/dist/src/index.js' },
            ] }),
        })

        const index = await qadamDistIndex.load({ qadamsRoot: root, useManifest: true })

        expect(index.get('@aiqadam/qadam-alpha')?.version).toBe('1.2.3')
    })
})
