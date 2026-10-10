import { renameSync } from 'node:fs'
import { chmod, cp, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
    DEFAULT_QADAM_VERSION_STORE_LIMITS,
    QadamVersionOrigin,
    QadamVersionPutResult,
    QadamVersionPutStatus,
    QadamVersionReadStatus,
    qadamVersionStore,
    QadamVersionStore,
} from '../src/qadam-version-store/qadam-version-store'
import { QadamArtifactFormat, QadamArtifactKind } from '../src/qadam-version-store/qadam-version-store-format'
import { QadamVersionCoordinates, qadamVersionStoreLayout } from '../src/qadam-version-store/qadam-version-store-layout'
import { qadamVersionStoreReader } from '../src/qadam-version-store/qadam-version-store-read'
import { TarEntry, tarFixtures } from './qadam-version-store-fixtures'

const PLATFORM_A = 'AAAAAAAAAAAAAAAAAAAAA'
const PLATFORM_B = 'BBBBBBBBBBBBBBBBBBBBB'
const CSV = { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0' }
const log = { info: vi.fn(), warn: vi.fn() }
const HOST = { os: process.platform, cpu: process.arch, libc: hostLibc(), node: process.versions.node }

let tempDir: string
let root: string
let store: QadamVersionStore

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-test-')))
    root = join(tempDir, 'store')
    store = await openStore()
    log.info.mockClear()
    log.warn.mockClear()
})

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreLayout', () => {
    it.each([
        [{ platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0' }],
        [{ platformId: null, name: '@aiqadam/qadam-csv', version: '1.0.0-main.12' }],
        [{ platformId: PLATFORM_A, name: 'my-qadam', version: '2.3.4' }],
        [{ platformId: PLATFORM_A, name: '@acme/qadam-crm', version: '0.0.1' }],
    ])('accepts %j', (coordinates) => {
        expect(qadamVersionStoreLayout.validateCoordinates(coordinates)).toEqual({ valid: true })
    })

    it.each([
        ['an unofficial name in the official namespace', { platformId: null, name: 'my-qadam', version: '1.0.0' }],
        ['a platform library in the official namespace', { platformId: null, name: '@aiqadam/qadams-framework', version: '1.0.0' }],
        ['the official scope in a platform namespace', { platformId: PLATFORM_A, name: '@aiqadam/qadam-csv', version: '1.0.0' }],
        ['an upper-cased official scope in a platform namespace', { platformId: PLATFORM_A, name: '@AIQADAM/qadam-csv', version: '1.0.0' }],
        ['a malformed platform id', { platformId: '../../etc', name: 'my-qadam', version: '1.0.0' }],
        ['a traversing name', { platformId: PLATFORM_A, name: '../qadam', version: '1.0.0' }],
        ['a scoped traversing name', { platformId: PLATFORM_A, name: '@acme/../../x', version: '1.0.0' }],
        ['node_modules as a name', { platformId: PLATFORM_A, name: 'node_modules', version: '1.0.0' }],
        ['a reserved-looking name', { platformId: PLATFORM_A, name: '_platform', version: '1.0.0' }],
        ['a traversing version', { platformId: null, name: '@aiqadam/qadam-csv', version: '../0.6.0' }],
        ['a non-canonical version', { platformId: null, name: '@aiqadam/qadam-csv', version: 'v0.6.0' }],
        ['build metadata', { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0+abc' }],
        ['a partial version', { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6' }],
        ['a prerelease other than a main snapshot (ADR-0004)', { platformId: null, name: '@aiqadam/qadam-csv', version: '1.0.0-beta.1' }],
        ['a snapshot without its counter', { platformId: null, name: '@aiqadam/qadam-csv', version: '1.0.0-main' }],
        ['a leading zero', { platformId: null, name: '@aiqadam/qadam-csv', version: '1.00.0' }],
    ])('refuses %s', (_label, coordinates) => {
        expect(qadamVersionStoreLayout.validateCoordinates(coordinates).valid).toBe(false)
        expect(() => qadamVersionStoreLayout.versionDir({ root, coordinates })).toThrow()
    })

    it('lays official and platform versions out as ADR-0003 names them', () => {
        expect(qadamVersionStoreLayout.versionDir({ root, coordinates: CSV })).toBe(join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0'))
        expect(qadamVersionStoreLayout.versionDir({ root, coordinates: { platformId: PLATFORM_A, name: '@acme/crm', version: '1.0.0' } }))
            .toBe(join(root, 'qadams', '_platform', PLATFORM_A, '@acme', 'crm', '1.0.0'))
    })
})

describe('qadamVersionStore.putTarball and read', () => {
    it('stores a bundle and reads it back, cheaply and fully verified', async () => {
        const result = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect(result.status).toBe(QadamVersionPutStatus.STORED)
        const read = await store.read({ coordinates: CSV, verify: true })
        expect(read.status).toBe(QadamVersionReadStatus.PRESENT)
        if (read.status !== QadamVersionReadStatus.PRESENT) {
            return
        }
        expect(read.version.format).toBe(QadamArtifactFormat.BUNDLE)
        expect(read.version.kind).toBe(QadamArtifactKind.BUNDLE)
        expect(read.version.entryPointPath).toBe(join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0', 'src', 'index.js'))
        expect(read.version.integrity.origin).toEqual({ kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: expect.stringMatching(/^sha512-/) })
        expect(read.version.integrity.tree.files).toBe(3)
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('stores a legacy npm version with its own third-party node_modules', async () => {
        const coordinates = { platformId: null, name: '@aiqadam/qadam-store', version: '0.7.0' }
        const result = await putFiles({ coordinates, files: tarFixtures.legacyFiles(coordinates) })

        expect(result.status).toBe(QadamVersionPutStatus.STORED)
        const read = await store.read({ coordinates, verify: true })
        expect(read.status === QadamVersionReadStatus.PRESENT && read.version.format).toBe(QadamArtifactFormat.LEGACY_NPM)
    })

    it('records the framework and platform version a snapshot was built against (ADR-0004 decision 8)', async () => {
        const coordinates = { ...CSV, version: '0.6.1-main.412' }
        const files = tarFixtures.bundleFiles({ name: coordinates.name, version: coordinates.version, builtAgainst: { framework: '0.36.0', platform: '1.1.1-main.412' } })

        expect((await putFiles({ coordinates, files })).status).toBe(QadamVersionPutStatus.STORED)

        const read = await store.read({ coordinates, verify: true })
        expect(read.status === QadamVersionReadStatus.PRESENT && read.version.integrity.builtAgainst).toEqual({ framework: '0.36.0', platform: '1.1.1-main.412' })
    })

    it.each([
        ['an artifact that says nothing', undefined],
        ['a value that is not an object', 'framework 0.36.0'],
        ['a framework that is not a version', { framework: 'latest' }],
        ['a platform that is not a version', { framework: '0.36.0', platform: '^1.1.0' }],
    ])('records nothing for %s and still stores the version', async (_label, builtAgainst) => {
        const files = tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, builtAgainst })

        expect((await putFiles({ coordinates: CSV, files })).status).toBe(QadamVersionPutStatus.STORED)

        const read = await store.read({ coordinates: CSV, verify: true })
        expect(read.status === QadamVersionReadStatus.PRESENT && read.version.integrity.builtAgainst).toBeNull()
    })

    it('never overwrites a stored version', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        const second = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, extra: { 'src/other.js': 'changed' } }) })

        expect(second.status).toBe(QadamVersionPutStatus.EXISTS)
        await expect(stat(join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0', 'src', 'other.js'))).rejects.toThrow()
        expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('the stored one is kept'))
    })

    it('stores a version exactly once when writers race', async () => {
        const tarball = await writeTarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) }) })
        const stores = await Promise.all([1, 2, 3, 4, 5].map(() => openStore()))

        const results = await Promise.all(stores.map((each) => each.putTarball({ coordinates: CSV, tarballPath: tarball.path, expectedIntegrity: tarball.integrity, origin: { kind: QadamVersionOrigin.IMAGE_SEED } })))

        expect(results.filter((r) => r.status === QadamVersionPutStatus.STORED)).toHaveLength(1)
        expect(results.filter((r) => r.status === QadamVersionPutStatus.EXISTS)).toHaveLength(4)
        expect((await store.read({ coordinates: CSV, verify: true })).status).toBe(QadamVersionReadStatus.PRESENT)
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('refuses a tarball that does not match its integrity, and one with a weak integrity', async () => {
        const tarball = await writeTarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) }) })
        const other = tarFixtures.integrity({ data: Buffer.from('something else') })

        const mismatch = await store.putTarball({ coordinates: CSV, tarballPath: tarball.path, expectedIntegrity: other, origin: { kind: QadamVersionOrigin.REGISTRY } })
        const weak = await store.putTarball({ coordinates: CSV, tarballPath: tarball.path, expectedIntegrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', origin: { kind: QadamVersionOrigin.REGISTRY } })

        expect(mismatch).toEqual({ status: QadamVersionPutStatus.REFUSED, reason: 'the tarball does not match its expected integrity' })
        expect(weak.status).toBe(QadamVersionPutStatus.REFUSED)
        expect((await store.read({ coordinates: CSV })).status).toBe(QadamVersionReadStatus.ABSENT)
    })

    it('refuses coordinates that cannot name a version, before touching the tarball', async () => {
        const result = await store.putTarball({ coordinates: { platformId: null, name: '@aiqadam/qadam-csv', version: '../../x' }, tarballPath: '/nonexistent', expectedIntegrity: tarFixtures.integrity({ data: Buffer.from('') }), origin: { kind: QadamVersionOrigin.REGISTRY } })

        expect(result.status).toBe(QadamVersionPutStatus.REFUSED)
    })
})

describe('archive extraction refuses hostile tarballs', () => {
    const valid = (): TarEntry[] => tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

    it.each<[string, () => TarEntry[], string]>([
        ['a path climbing out with ..', () => [...valid(), { path: 'package/../../escaped.js', type: '0', content: 'x' }], 'not a plain relative path'],
        ['an absolute path', () => [...valid(), { path: '/tmp/escaped.js', type: '0', content: 'x' }], 'not a plain relative path'],
        ['a symlink', () => [...valid(), { path: 'package/src/link.js', type: '2', linkname: '/etc/passwd' }], 'SymbolicLink is not allowed'],
        ['a hard link', () => [...valid(), { path: 'package/src/link.js', type: '1', linkname: 'package/package.json' }], 'Link is not allowed'],
        ['a device', () => [...valid(), { path: 'package/dev', type: '3' }], 'CharacterDevice is not allowed'],
        ['the same path twice', () => [...valid(), { path: 'package/src/index.js', type: '0', content: 'again' }], 'the same path appears twice'],
        ['two top-level directories', () => [...valid(), { path: 'other/file.js', type: '0', content: 'x' }], 'one top-level directory'],
        ['a file at the top level', () => [{ path: 'loose.js', type: '0', content: 'x' }, ...valid()], 'top level of the archive'],
        ['a backslash path', () => [...valid(), { path: 'package\\..\\escaped.js', type: '0', content: 'x' }], 'not a plain relative path'],
    ])('refuses %s', async (_label, entries, reason) => {
        const result = await putEntries({ coordinates: CSV, entries: entries() })

        expect(result.status).toBe(QadamVersionPutStatus.REFUSED)
        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain(reason)
        await expectNothingWritten()
    })

    it('refuses an entry the tar parser skips, which would otherwise pass every limit', async () => {
        const entries: TarEntry[] = [...valid(), { path: 'package/huge.bin', type: 'S' }]

        const result = await putEntries({ coordinates: CSV, entries })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain('entry type')
        await expectNothingWritten()
    })

    it('refuses a tarball over the entry, byte and file-size limits', async () => {
        const small = await openStore({ limits: { maxEntries: 3, maxBytes: DEFAULT_QADAM_VERSION_STORE_LIMITS.maxBytes, maxFileBytes: DEFAULT_QADAM_VERSION_STORE_LIMITS.maxFileBytes } })
        const tiny = await openStore({ limits: { maxEntries: 100, maxBytes: 100, maxFileBytes: 1_000 } })
        const tarball = await writeTarball({ entries: valid() })

        const byEntries = await small.putTarball({ coordinates: CSV, tarballPath: tarball.path, expectedIntegrity: tarball.integrity, origin: { kind: QadamVersionOrigin.REGISTRY } })
        const byBytes = await tiny.putTarball({ coordinates: CSV, tarballPath: tarball.path, expectedIntegrity: tarball.integrity, origin: { kind: QadamVersionOrigin.REGISTRY } })

        expect(byEntries.status === QadamVersionPutStatus.REFUSED && byEntries.reason).toContain('entries')
        expect(byBytes.status === QadamVersionPutStatus.REFUSED && byBytes.reason).toContain('bytes')
        await expectNothingWritten()
    })

    it('refuses a file that is not a tarball', async () => {
        const path = join(tempDir, 'garbage.tgz')
        const data = Buffer.from('this is not a tarball at all, not even gzip')
        await writeFile(path, data)

        const result = await store.putTarball({ coordinates: CSV, tarballPath: path, expectedIntegrity: tarFixtures.integrity({ data }), origin: { kind: QadamVersionOrigin.REGISTRY } })

        expect(result.status).toBe(QadamVersionPutStatus.REFUSED)
        await expectNothingWritten()
    })

    it('strips setuid and other mode bits, keeping only executable or not', async () => {
        const entries = [...valid(), { path: 'package/bin/tool', type: '0' as const, content: '#!/bin/sh', mode: 0o4777 }]

        await putEntries({ coordinates: CSV, entries })

        const mode = (await stat(join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0', 'bin', 'tool'))).mode & 0o7777
        expect(mode & 0o7000).toBe(0)
        expect(mode & 0o111).not.toBe(0)
    })
})

describe('format checks', () => {
    it.each<[string, Record<string, string>, string]>([
        ['an artifact format this platform does not read', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 2, kind: 'bundle' } }) }, 'format version 2'],
        ['an unknown artifact kind', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 1, kind: 'wasm' } }) }, 'kind wasm'],
        ['a peer the platform does not provide', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', peerDependencies: { 'left-pad': '1' }, qadamArtifact: { formatVersion: 1, kind: 'bundle' } }) }, 'does not provide: left-pad'],
        ['its own copy of the framework', { 'node_modules/@aiqadam/qadams-framework/index.js': '' }, 'own copy of @aiqadam/qadams-framework'],
        ['its own top-level zod', { 'node_modules/zod/index.js': '' }, 'own copy of zod'],
        ['a package.json naming another version', { 'package.json': JSON.stringify({ name: CSV.name, version: '9.9.9', main: './src/index.js' }) }, 'package.json names another'],
        ['an entry point outside the version', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: '../../../../etc/passwd' }) }, 'entry point'],
        ['metadata naming another qadam', { 'metadata.json': JSON.stringify({ name: 'other', version: CSV.version, actions: {}, triggers: {} }) }, 'metadata.json names another'],
        ['native modules built for another host', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 1, kind: 'bundle-with-node-modules', builtFor: { os: 'plan9', cpu: 'mips', libc: 'glibc 2.17', node: process.versions.node } } }) }, 'built for plan9-mips'],
        ['native modules built without a record of libc and node', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 1, kind: 'bundle-with-node-modules', builtFor: { os: process.platform, cpu: process.arch } } }) }, 'without a record'],
        ['native modules built for another Node major', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 1, kind: 'bundle-with-node-modules', builtFor: { ...HOST, node: '18.20.0' } } }) }, 'node 18.20.0'],
        ['native modules built against a newer glibc', { 'package.json': JSON.stringify({ name: CSV.name, version: CSV.version, main: './src/index.js', qadamArtifact: { formatVersion: 1, kind: 'bundle-with-node-modules', builtFor: { ...HOST, libc: 'glibc 99.0' } } }) }, 'glibc 99.0'],
    ])('refuses %s', async (_label, overrides, reason) => {
        const files = { ...tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version }), ...overrides }

        const result = await putFiles({ coordinates: CSV, files })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain(reason)
        await expectNothingWritten()
    })

    it('refuses a version without metadata.json', async () => {
        const { 'metadata.json': _omitted, ...files } = tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version })

        const result = await putFiles({ coordinates: CSV, files })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain('metadata.json')
    })

    it.each<[string, string | undefined, Record<string, string>, string]>([
        ['no main', undefined, { 'index.js': 'module.exports = {}' }, 'index.js'],
        ['an empty main', '', { 'index.js': 'module.exports = {}' }, 'index.js'],
        ['a directory main with a trailing slash', 'dist/', { 'dist/index.js': 'module.exports = {}' }, 'dist/index.js'],
        ['a main without its extension', './lib/entry', { 'lib/entry.js': 'module.exports = {}' }, 'lib/entry.js'],
        ['a main that names nothing, falling back to index.js as Node does', './missing.js', { 'index.js': 'module.exports = {}' }, 'index.js'],
    ])('resolves the entry point as Node does for %s', async (_label, main, extra, entryPoint) => {
        const { 'src/index.js': _bundle, ...base } = tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version })
        const manifest = { name: CSV.name, version: CSV.version, ...(main === undefined ? {} : { main }) }

        const result = await putFiles({ coordinates: CSV, files: { ...base, ...extra, 'package.json': JSON.stringify(manifest) } })

        expect(result.status === QadamVersionPutStatus.STORED && result.version.integrity.entryPoint).toBe(entryPoint)
    })

    it('accepts a private zod nested under a third-party dependency of a legacy version', async () => {
        const files = tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version, extra: { 'node_modules/left-pad/node_modules/zod/index.js': '' } })

        expect((await putFiles({ coordinates: CSV, files })).status).toBe(QadamVersionPutStatus.STORED)
    })
})

describe('qadamVersionStore.commit from a staged directory', () => {
    it('accepts a symlink that stays inside the version, as a package manager writes in node_modules/.bin', async () => {
        const staging = await store.createStaging()
        await tarFixtures.writeFiles({ dir: staging, files: tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version }) })
        await mkdir(join(staging, 'node_modules', '.bin'))
        await symlink('../left-pad/index.js', join(staging, 'node_modules', '.bin', 'left-pad'))

        const result = await store.commit({ coordinates: CSV, stagingDir: staging, origin: { kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: null } })

        expect(result.status).toBe(QadamVersionPutStatus.STORED)
        expect((await store.read({ coordinates: CSV, verify: true })).status).toBe(QadamVersionReadStatus.PRESENT)
    })

    it.each<[string, (staging: string) => Promise<void>, string]>([
        ['an absolute symlink', (staging) => symlink('/etc/passwd', join(staging, 'passwd')), 'absolute target'],
        ['a relative symlink climbing out', async (staging) => {
            await writeFile(join(tempDir, 'outside.txt'), 'secret')
            await symlink(relative(staging, join(tempDir, 'outside.txt')), join(staging, 'outside'))
        }, 'outside the version'],
        ['a dangling symlink', (staging) => symlink('missing.js', join(staging, 'dangling')), 'does not resolve'],
        ['a symlink written to climb out, even when it resolves inside today', async (staging) => {
            await mkdir(join(staging, 'lib'))
            await symlink(`../../${staging.split('/').at(-1)}/package.json`, join(staging, 'lib', 'manifest'))
        }, 'points outside the version'],
        ['a chain of symlinks climbing out together', async (staging) => {
            await symlink('.', join(staging, 'here'))
            await symlink('here/..', join(staging, 'parent'))
        }, 'outside the version'],
        ['a hard link', (staging) => link(join(staging, 'package.json'), join(staging, 'package-copy.json')), 'hard link'],
    ])('refuses %s', async (_label, plant, reason) => {
        const staging = await store.createStaging()
        await tarFixtures.writeFiles({ dir: staging, files: tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version }) })
        await plant(staging)

        const result = await store.commit({ coordinates: CSV, stagingDir: staging, origin: { kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: null } })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain(reason)
        await expectNothingWritten()
    })

    it('accepts a file whose name starts with two dots, which is not a parent directory', async () => {
        const staging = await store.createStaging()
        await tarFixtures.writeFiles({ dir: staging, files: tarFixtures.legacyFiles({ name: CSV.name, version: CSV.version, extra: { '..cache/data.json': '{}' } }) })
        await symlink('..cache/data.json', join(staging, 'data-link.json'))

        const result = await store.commit({ coordinates: CSV, stagingDir: staging, origin: { kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: null } })

        expect(result.status).toBe(QadamVersionPutStatus.STORED)
    })

    it('refuses to write through a symlinked directory of the layout, and creates nothing where it points', async () => {
        const elsewhere = join(tempDir, 'elsewhere')
        await mkdir(elsewhere)
        await symlink(elsewhere, join(root, 'qadams', '@aiqadam'))

        const result = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain('symlink')
        expect(await readdir(elsewhere)).toEqual([])
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('refuses to commit or discard a directory that is not its own staging directory', async () => {
        const elsewhere = join(tempDir, 'elsewhere')
        await mkdir(elsewhere)

        await expect(store.commit({ coordinates: CSV, stagingDir: elsewhere, origin: { kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: null } })).rejects.toThrow('not a staging directory')
        await expect(store.discardStaging({ stagingDir: join(root, '.staging', '..', '..') })).rejects.toThrow('not a staging directory')
        expect((await stat(elsewhere)).isDirectory()).toBe(true)
    })
})

describe('damaged versions', () => {
    beforeEach(async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
    })

    it('finds a rewritten file only with a full verification', async () => {
        await writeFile(join(versionDir(CSV), 'src', 'index.js'), 'tampered')

        expect((await store.read({ coordinates: CSV })).status).toBe(QadamVersionReadStatus.PRESENT)
        expect(await store.read({ coordinates: CSV, verify: true })).toEqual({ status: QadamVersionReadStatus.DAMAGED, reason: 'the content does not match integrity.json' })
    })

    it('replaces a version whose integrity record is gone', async () => {
        await unlink(join(versionDir(CSV), 'integrity.json'))
        expect((await store.read({ coordinates: CSV })).status).toBe(QadamVersionReadStatus.DAMAGED)

        const again = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect(again.status).toBe(QadamVersionPutStatus.STORED)
        expect((await store.read({ coordinates: CSV, verify: true })).status).toBe(QadamVersionReadStatus.PRESENT)
    })

    it('treats a version reached through a symlinked directory as invalid', async () => {
        const real = join(tempDir, 'elsewhere')
        await rm(join(root, 'qadams', '@aiqadam', 'qadam-csv'), { recursive: true })
        await mkdir(join(real, '0.6.0'), { recursive: true })
        await symlink(real, join(root, 'qadams', '@aiqadam', 'qadam-csv'))

        expect(await store.read({ coordinates: CSV })).toEqual({ status: QadamVersionReadStatus.DAMAGED, reason: 'the version path goes through a symlink' })
    })

    it('treats an integrity record for other coordinates as invalid', async () => {
        const integrityPath = join(versionDir(CSV), 'integrity.json')
        const record = JSON.parse(await readFile(integrityPath, 'utf8'))
        await writeFile(integrityPath, JSON.stringify({ ...record, platformId: PLATFORM_A }))

        expect(await store.read({ coordinates: CSV })).toEqual({ status: QadamVersionReadStatus.DAMAGED, reason: 'integrity.json names another version' })
    })
})

describe('versions that are not damaged are never replaced', () => {
    const versionPath = (): string => versionDir(CSV)

    it.each<[string, () => Promise<void>, QadamVersionReadStatus]>([
        ['a newer store format', async () => editIntegrity({ storeFormatVersion: 2 }), QadamVersionReadStatus.UNSUPPORTED],
        ['an origin kind a later release added', async () => editIntegrity({ origin: { kind: 'mirror', tarballIntegrity: null } }), QadamVersionReadStatus.UNSUPPORTED],
        ['an artifact format version a later release added', async () => editPackageJson({ qadamArtifact: { formatVersion: 2, kind: 'bundle' } }), QadamVersionReadStatus.UNSUPPORTED],
        ['native modules built for another host', async () => {
            await rm(versionPath(), { recursive: true })
            await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, kind: 'bundle-with-node-modules', builtFor: HOST }) })
            await editPackageJson({ qadamArtifact: { formatVersion: 1, kind: 'bundle-with-node-modules', builtFor: { ...HOST, cpu: HOST.cpu === 'arm64' ? 'x64' : 'arm64' } } })
        }, QadamVersionReadStatus.UNSUPPORTED],
        ['an integrity record the process cannot read', async () => chmod(join(versionPath(), 'integrity.json'), 0o000), QadamVersionReadStatus.UNREADABLE],
    ])('keeps a version with %s', async (_label, change, status) => {
        if (status === QadamVersionReadStatus.UNREADABLE && process.getuid?.() === 0) {
            return
        }
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        await change()
        const before = await readdir(versionPath(), { recursive: true })

        const read = await store.read({ coordinates: CSV })
        const again = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, extra: { 'src/new.js': 'x' } }) })

        expect(read.status).toBe(status)
        expect(again.status === QadamVersionPutStatus.REFUSED && again.reason).toContain('is kept')
        expect(await readdir(versionPath(), { recursive: true })).toEqual(before)
        expect(await readdir(join(root, '.trash'))).toEqual([])
        expect(await readdir(join(root, '.staging'))).toEqual([])
        await chmod(join(versionPath(), 'integrity.json'), 0o644).catch(() => undefined)
    })

    it('puts back a good version another writer stored while this one was replacing the damaged one', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        const goodCopy = join(tempDir, 'good-copy')
        await cp(versionPath(), goodCopy, { recursive: true })
        await unlink(join(versionPath(), 'integrity.json'))
        // The other writer wins exactly between this writer's read (damaged) and its move aside.
        log.warn.mockImplementationOnce((_obj: unknown, msg: string) => {
            if (msg.includes('Replacing a damaged version')) {
                renameSync(versionPath(), join(tempDir, 'damaged-moved-by-the-other-writer'))
                renameSync(goodCopy, versionPath())
            }
        })

        const result = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, extra: { 'src/new.js': 'x' } }) })

        expect(result.status).toBe(QadamVersionPutStatus.EXISTS)
        expect((await store.read({ coordinates: CSV, verify: true })).status).toBe(QadamVersionReadStatus.PRESENT)
        await expect(stat(join(versionPath(), 'src', 'new.js'))).rejects.toThrow()
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('puts back a version a later release stored while this one was replacing the damaged one', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        const laterRelease = join(tempDir, 'later-release-copy')
        await cp(versionPath(), laterRelease, { recursive: true })
        const laterRecord = { ...JSON.parse(await readFile(join(laterRelease, 'integrity.json'), 'utf8')), storeFormatVersion: 2, marker: 'N+1' }
        await writeFile(join(laterRelease, 'integrity.json'), JSON.stringify(laterRecord))
        await unlink(join(versionPath(), 'integrity.json'))
        log.warn.mockImplementationOnce((_obj: unknown, msg: string) => {
            if (msg.includes('Replacing a damaged version')) {
                renameSync(versionPath(), join(tempDir, 'damaged-moved-by-the-other-writer'))
                renameSync(laterRelease, versionPath())
            }
        })

        const result = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version, extra: { 'src/new.js': 'x' } }) })

        expect(result.status === QadamVersionPutStatus.REFUSED && result.reason).toContain('is kept')
        expect(JSON.parse(await readFile(join(versionPath(), 'integrity.json'), 'utf8'))).toEqual(laterRecord)
        expect((await store.read({ coordinates: CSV })).status).toBe(QadamVersionReadStatus.UNSUPPORTED)
        expect(await readdir(join(root, '.trash'))).toEqual([])
    })

    it('treats an integrity record larger than this release writes as a later release\'s, and keeps it', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        await editIntegrity({ storeFormatVersion: 2, signatures: 'x'.repeat(70_000) })
        const before = await readFile(join(versionPath(), 'integrity.json'), 'utf8')

        const read = await store.read({ coordinates: CSV })
        const again = await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect(read.status).toBe(QadamVersionReadStatus.UNSUPPORTED)
        expect(again.status === QadamVersionPutStatus.REFUSED && again.reason).toContain('is kept')
        expect(await readFile(join(versionPath(), 'integrity.json'), 'utf8')).toBe(before)
    })

    it('stores versions readable by other users of the volume', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect((await stat(versionPath())).mode & 0o777).toBe(0o755)
        expect((await stat(join(versionPath(), 'src'))).mode & 0o777).toBe(0o755)
        expect((await stat(join(versionPath(), 'src', 'index.js'))).mode & 0o777).toBe(0o644)
    })
})

describe('per-platform namespaces', () => {
    it('keeps each platform\'s custom qadams apart from other platforms and from the official namespace', async () => {
        const custom = { platformId: PLATFORM_A, name: '@acme/crm', version: '1.0.0' }
        await putFiles({ coordinates: custom, files: tarFixtures.legacyFiles({ name: custom.name, version: custom.version }) })
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        expect((await store.read({ coordinates: custom })).status).toBe(QadamVersionReadStatus.PRESENT)
        expect((await store.read({ coordinates: { ...custom, platformId: PLATFORM_B } })).status).toBe(QadamVersionReadStatus.ABSENT)
        expect(await store.listVersions({ platformId: PLATFORM_A })).toEqual([custom])
        expect(await store.listVersions({ platformId: PLATFORM_B })).toEqual([])
        expect(await store.listVersions({ platformId: null })).toEqual([CSV])
    })

    it('lists versions in semver order', async () => {
        for (const version of ['0.10.0', '0.9.1', '0.9.0']) {
            await putFiles({ coordinates: { ...CSV, version }, files: tarFixtures.bundleFiles({ name: CSV.name, version }) })
        }

        expect((await store.listVersions({ platformId: null })).map((c) => c.version)).toEqual(['0.9.0', '0.9.1', '0.10.0'])
    })
})

describe('loading a stored version', () => {
    // The store keeps `<root>/qadams/node_modules` for the libraries the platform provides (#779
    // decides how the engine fills it). A version of either format, in either namespace, must find
    // them there by Node's ordinary upward lookup, and a legacy version must still find its own
    // third-party dependencies inside itself.
    it.each([
        ['an official bundle', CSV, 'bundle', null],
        ['an official legacy npm version', { platformId: null, name: '@aiqadam/qadam-store', version: '0.7.0' }, 'legacy', 'left-pad inside the version'],
        ['a custom legacy version of a platform', { platformId: PLATFORM_A, name: '@acme/crm', version: '1.0.0' }, 'legacy', 'left-pad inside the version'],
    ])('resolves the platform framework for %s', async (_label, coordinates, format, pad) => {
        await tarFixtures.writeFiles({
            dir: join(root, 'qadams', 'node_modules', '@aiqadam', 'qadams-framework'),
            files: { 'package.json': JSON.stringify({ name: '@aiqadam/qadams-framework', main: 'index.js' }), 'index.js': 'exports.marker = "platform copy"\n' },
        })
        const files = format === 'bundle'
            ? tarFixtures.bundleFiles({ name: coordinates.name, version: coordinates.version })
            : tarFixtures.legacyFiles({ name: coordinates.name, version: coordinates.version })
        await putFiles({ coordinates, files })
        const read = await store.read({ coordinates })
        if (read.status !== QadamVersionReadStatus.PRESENT) {
            throw new Error(`expected the version to be present, got ${read.status}`)
        }

        const loaded = createRequire(read.version.entryPointPath)(read.version.entryPointPath)

        expect(loaded.loaded).toEqual({ framework: 'platform copy', pad })
    })
})

describe('qadamVersionStore.open', () => {
    it('removes trash and staging left by a dead process, and keeps a recent staging directory', async () => {
        const old = join(root, '.staging', `${Date.now() - 7 * 60 * 60 * 1000}-dead`)
        const recent = join(root, '.staging', `${Date.now()}-live`)
        const oldTrash = join(root, '.trash', `${Date.now() - 7 * 60 * 60 * 1000}-aside`)
        const recentTrash = join(root, '.trash', `${Date.now()}-aside`)
        await Promise.all([mkdir(old), mkdir(recent), mkdir(oldTrash), mkdir(recentTrash)])

        await openStore()

        expect(await readdir(join(root, '.staging'))).toEqual([recent.split('/').at(-1)])
        expect(await readdir(join(root, '.trash'))).toEqual([recentTrash.split('/').at(-1)])
    })

    it('refuses a root from which stored versions could resolve an app\'s node_modules', async () => {
        await mkdir(join(tempDir, 'app', 'node_modules'), { recursive: true })

        const opened = await qadamVersionStore.open({ root: join(tempDir, 'app', 'qadam-versions'), log })

        expect(opened.ok === false && opened.reason).toContain(join(tempDir, 'app', 'node_modules'))
    })

    it('reports a root it cannot prepare instead of throwing', async () => {
        const file = join(tempDir, 'a-file')
        await writeFile(file, '')

        const opened = await qadamVersionStore.open({ root: join(file, 'store'), log })

        expect(opened.ok).toBe(false)
    })
})

describe('qadamVersionStoreReader.open', () => {
    it('reads a version whose entry point resolves outside it as damaged', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        const outside = join(tempDir, 'elsewhere')
        await cp(join(versionDir(CSV), 'src'), outside, { recursive: true })
        await rm(join(versionDir(CSV), 'src'), { recursive: true })
        await symlink(outside, join(versionDir(CSV), 'src'))

        const read = await store.read({ coordinates: CSV })

        expect(read).toEqual({ status: QadamVersionReadStatus.DAMAGED, reason: 'the entry point resolves outside the version' })
    })

    it('reads a version whose package.json is not a regular file as damaged', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })
        await rm(join(versionDir(CSV), 'package.json'))
        await mkdir(join(versionDir(CSV), 'package.json'))

        const read = await store.read({ coordinates: CSV })

        expect(read).toEqual({ status: QadamVersionReadStatus.DAMAGED, reason: 'package.json is not a regular file' })
    })

    it('reads what the store holds', async () => {
        await putFiles({ coordinates: CSV, files: tarFixtures.bundleFiles({ name: CSV.name, version: CSV.version }) })

        const opened = await qadamVersionStoreReader.open({ root })
        if (!opened.ok) {
            throw new Error(opened.reason)
        }
        const read = await opened.reader.read({ coordinates: CSV })

        expect(opened.reader.root).toBe(root)
        expect(read.status).toBe(QadamVersionReadStatus.PRESENT)
        expect(await opened.reader.read({ coordinates: { ...CSV, version: '9.9.9' } })).toEqual({ status: QadamVersionReadStatus.ABSENT })
    })

    it('writes nothing: no directory, no probe, no leftover cleanup', async () => {
        const leftover = join(root, '.staging', `${Date.now() - 7 * 60 * 60 * 1000}-dead`)
        await mkdir(leftover)
        const missingRoot = join(tempDir, 'never-opened')

        const opened = await qadamVersionStoreReader.open({ root })
        const missing = await qadamVersionStoreReader.open({ root: missingRoot })

        expect(opened.ok).toBe(true)
        expect(await readdir(join(root, '.staging'))).toEqual([leftover.split('/').at(-1)])
        expect(missing).toEqual({ ok: false, reason: 'the store directory cannot be read (ENOENT)' })
        await expect(stat(missingRoot)).rejects.toThrow()
    })

    it('refuses a root from which stored versions could resolve an app\'s node_modules, without naming the path', async () => {
        const below = join(tempDir, 'app', 'qadam-versions')
        await mkdir(join(tempDir, 'app', 'node_modules'), { recursive: true })
        await mkdir(below)

        const opened = await qadamVersionStoreReader.open({ root: below })

        expect(opened).toEqual({ ok: false, reason: 'stored versions could resolve packages from a node_modules above the store' })
    })

    it('answers with the real path of a root reached through a symlink', async () => {
        const link = join(tempDir, 'store-link')
        await symlink(root, link)

        const opened = await qadamVersionStoreReader.open({ root: link })

        expect(opened.ok && opened.reader.root).toBe(root)
    })
})

async function openStore({ limits }: { limits?: typeof DEFAULT_QADAM_VERSION_STORE_LIMITS } = {}): Promise<QadamVersionStore> {
    const opened = await qadamVersionStore.open({ root, log, limits })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    return opened.store
}

async function writeTarball({ entries }: { entries: TarEntry[] }): Promise<{ path: string, integrity: string }> {
    const data = tarFixtures.tarball({ entries })
    const path = join(tempDir, `fixture-${Math.random().toString(36).slice(2)}.tgz`)
    await writeFile(path, data)
    return { path, integrity: tarFixtures.integrity({ data }) }
}

async function putEntries({ coordinates, entries }: { coordinates: QadamVersionCoordinates, entries: TarEntry[] }): Promise<QadamVersionPutResult> {
    const tarball = await writeTarball({ entries })
    return store.putTarball({ coordinates, tarballPath: tarball.path, expectedIntegrity: tarball.integrity, origin: { kind: QadamVersionOrigin.REGISTRY } })
}

async function putFiles({ coordinates, files }: { coordinates: QadamVersionCoordinates, files: Record<string, string> }): Promise<QadamVersionPutResult> {
    return putEntries({ coordinates, entries: tarFixtures.artifactEntries({ files }) })
}

function versionDir(coordinates: QadamVersionCoordinates): string {
    return qadamVersionStoreLayout.versionDir({ root, coordinates })
}

async function editIntegrity(changes: Record<string, unknown>): Promise<void> {
    const file = join(versionDir(CSV), 'integrity.json')
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...changes }))
}

async function editPackageJson(changes: Record<string, unknown>): Promise<void> {
    const file = join(versionDir(CSV), 'package.json')
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...changes }))
}

async function expectNothingWritten(): Promise<void> {
    expect(await readdir(join(root, 'qadams'))).toEqual([])
    expect(await readdir(join(root, '.staging'))).toEqual([])
    expect(await readdir(tempDir)).not.toContain('escaped.js')
}

function hostLibc(): string {
    const glibc = z.object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) }).safeParse(process.report?.getReport()).data?.header.glibcVersionRuntime
    return glibc === undefined ? 'unknown' : `glibc ${glibc}`
}
