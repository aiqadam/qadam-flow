import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const API_ROOT = path.resolve(__dirname, '../../../..')
const WRITER = path.join(API_ROOT, 'src', 'scripts', 'write-bundled-qadams-manifest.ts')
const MANIFEST_FILE = 'bundled-qadams-metadata.json'

let qadamsRoot: string

// The Dockerfile's contract with the writer is its exit code: anything but 0 fails the image build.
// So the script runs here as the image runs it, in its own process, rather than as an import.
describe('write-bundled-qadams-manifest (#598)', () => {
    beforeEach(async () => {
        qadamsRoot = path.join(await mkdtemp(path.join(tmpdir(), 'bundled-qadams-writer-')), 'packages', 'qadams')
        await mkdir(qadamsRoot, { recursive: true })
    })

    afterEach(async () => {
        await rm(path.dirname(path.dirname(qadamsRoot)), { recursive: true, force: true })
    })

    it('writes every built qadam and exits 0', async () => {
        await writeFixtureQadam({ name: 'alpha', loads: true })
        await writeFixtureQadam({ name: 'beta', loads: true })

        const { exitCode, stdout } = await runWriter()

        expect(exitCode).toBe(0)
        expect(stdout).toContain('[bundledQadamsManifest] wrote 2 qadams to the manifest')
        const manifest = JSON.parse(await readFile(path.join(qadamsRoot, MANIFEST_FILE), 'utf-8'))
        expect(manifest.version).toBe(1)
        expect(manifest.qadams.map((qadam: { name: string }) => qadam.name).sort()).toEqual(['@fixture/alpha', '@fixture/beta'])
    })

    it('exits 1 and writes nothing for a tree with no built qadam', async () => {
        const { exitCode, stderr } = await runWriter()

        expect(exitCode).toBe(1)
        expect(stderr).toContain('no bundled qadams loaded')
        expect(await exists(path.join(qadamsRoot, MANIFEST_FILE))).toBe(false)
    })

    it('exits 1, names the qadam, and writes nothing when one built qadam fails to load', async () => {
        await writeFixtureQadam({ name: 'alpha', loads: true })
        await writeFixtureQadam({ name: 'broken', loads: false })

        const { exitCode, stderr } = await runWriter()

        expect(exitCode).toBe(1)
        expect(stderr).toContain('1 built qadam(s) failed to load, refusing a partial manifest')
        expect(stderr).toContain(path.join('community', 'broken', 'dist'))
        expect(await exists(path.join(qadamsRoot, MANIFEST_FILE))).toBe(false)
    })

    it('exits 1 without a qadams root argument', async () => {
        const { exitCode, stderr } = await runWriter({ withRoot: false })

        expect(exitCode).toBe(1)
        expect(stderr).toContain('usage: write-bundled-qadams-manifest.js <qadams root>')
    })
})

async function runWriter({ withRoot = true }: { withRoot?: boolean } = {}): Promise<WriterRun> {
    const args = ['--import', 'tsx', WRITER, ...(withRoot ? [qadamsRoot] : [])]
    const { error, stdout, stderr } = await execFileAsync(process.execPath, args, { cwd: API_ROOT, env: { ...process.env, AP_LOG_LEVEL: 'silent' } })
        .then(({ stdout, stderr }) => ({ error: null, stdout, stderr }))
        .catch((error: { code?: number, stdout?: string, stderr?: string }) => ({ error, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
    return { exitCode: error === null ? 0 : error.code ?? -1, stdout, stderr }
}

async function writeFixtureQadam({ name, loads }: { name: string, loads: boolean }): Promise<void> {
    const distRoot = path.join(qadamsRoot, 'community', name, 'dist')
    const packageJson = JSON.stringify({ name: `@fixture/${name}`, version: '0.0.1' })
    await mkdir(path.join(distRoot, 'src'), { recursive: true })
    await writeFile(path.join(qadamsRoot, 'community', name, 'package.json'), packageJson)
    await writeFile(path.join(distRoot, 'package.json'), packageJson)
    // `extractQadamFromModule` matches on the constructor name; a throwing module is what a dist with
    // a dependency missing from the production install looks like to the scan.
    await writeFile(path.join(distRoot, 'src', 'index.js'), loads ? `
class Qadam {
    constructor() { this.authors = ['fixture'] }
    metadata() {
        return { displayName: ${JSON.stringify(name)}, logoUrl: '', actions: {}, triggers: {}, categories: [], authors: this.authors, minimumSupportedRelease: '0.0.0' }
    }
}
exports.qadam = new Qadam()
` : 'throw new Error(\'Cannot find module some-dependency\')\n')
}

async function exists(filePath: string): Promise<boolean> {
    return stat(filePath).then(() => true, () => false)
}

type WriterRun = {
    exitCode: number
    stdout: string
    stderr: string
}
