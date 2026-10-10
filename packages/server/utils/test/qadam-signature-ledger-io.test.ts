import { generateKeyPairSync, KeyObject, sign } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNpmPackageSignatureVerifier } from '../src/npm-package-signature'
import { createQadamSignatureLedger, QadamSignatureLedger, QadamSignatureUnverified } from '../src/qadam-version-store/qadam-signature-ledger'
import { QadamArtifactFormat } from '../src/qadam-version-store/qadam-version-store-format'
import { QadamVersionOrigin, StoredQadamVersion } from '../src/qadam-version-store/qadam-version-store-read'

// A read error is not evidence about the file, so it must neither be taken for an empty ledger when
// recording (which would overwrite every persisted proof) nor cost more than one read per sweep. The
// fs calls the ledger makes on the ledger file are the only thing faked here.
const control = vi.hoisted(() => ({
    lstatError: null as Error | null,
    readError: null as Error | null,
    reads: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        lstat: async (...args: Parameters<typeof actual.lstat>): Promise<Awaited<ReturnType<typeof actual.lstat>>> => {
            if (control.lstatError !== null) {
                throw control.lstatError
            }
            return actual.lstat(...args)
        },
        readFile: async (...args: Parameters<typeof actual.readFile>): Promise<Awaited<ReturnType<typeof actual.readFile>>> => {
            control.reads += 1
            if (control.readError !== null) {
                throw control.readError
            }
            return actual.readFile(...args)
        },
    }
})

const KEY_ID = 'SHA256:test-signing-key'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const verifier = createNpmPackageSignatureVerifier({ trustedKeys: { [KEY_ID]: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } })
const TABLES = { name: '@aiqadam/qadam-tables', version: '0.5.1', integrity: 'sha512-AAAA' }
const log = { warn: vi.fn() }

let dir: string
let ledgerFile: string
let ledger: QadamSignatureLedger

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-signature-ledger-io-')))
    ledgerFile = join(dir, 'qadam-signatures.json')
    ledger = createQadamSignatureLedger({ dir, log, verifier })
    log.warn.mockClear()
    control.lstatError = null
    control.readError = null
    control.reads = 0
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('a ledger that cannot be read', () => {
    it.each([
        ['lstat fails with EACCES', 'lstatError', 'EACCES'],
        ['lstat fails with ESTALE', 'lstatError', 'ESTALE'],
        ['the read fails with EIO', 'readError', 'EIO'],
        ['the read fails with ENFILE', 'readError', 'ENFILE'],
    ] as const)('is never overwritten when %s', async (_label, which, code) => {
        expect(await ledger.record({ proofs: [proofFor(TABLES)] })).toMatchObject({ ok: true, recorded: 1 })
        const before = await readFile(ledgerFile, 'utf8')
        control[which] = Object.assign(new Error('injected'), { code })

        const recorded = await ledger.record({ proofs: [proofFor({ ...TABLES, version: '0.5.2' })] })
        const checked = await ledger.check({ packages: [TABLES] })
        control[which] = null

        expect(recorded).toEqual({ ok: false, reason: `the ledger cannot be read (${code})` })
        expect(checked.unverified).toEqual([{ package: TABLES, reason: QadamSignatureUnverified.LEDGER_UNUSABLE }])
        expect(await readFile(ledgerFile, 'utf8')).toBe(before)
        expect((await ledger.check({ packages: [TABLES] })).verified).toEqual([TABLES])
    })

    it('is treated as absent when it vanishes between the stat and the read', async () => {
        await writeFile(ledgerFile, JSON.stringify({ formatVersion: 1, entries: [] }))
        control.readError = Object.assign(new Error('gone'), { code: 'ENOENT' })

        const recorded = await ledger.record({ proofs: [proofFor(TABLES)] })
        control.readError = null

        expect(recorded).toEqual({ ok: true, recorded: 1, rejected: 0 })
    })
})

describe('checkStoredVersions', () => {
    it('reads and parses the ledger once for any number of versions, and answers in their order', async () => {
        const versions = Array.from({ length: 5 }, (_, index) => storedVersion({ name: `@aiqadam/qadam-n${index}`, version: '1.0.0', tarballIntegrity: `sha512-${index}` }))
        await ledger.record({ proofs: versions.slice(0, 3).map((version) => proofFor({ name: version.integrity.name, version: version.integrity.version, integrity: version.integrity.origin.tarballIntegrity ?? '' })) })
        control.reads = 0

        const checks = await ledger.checkStoredVersions({ versions })

        expect(control.reads).toBe(1)
        expect(checks.map((check) => check.verified)).toEqual([true, true, true, false, false])
        expect(checks[3]).toEqual({ verified: false, reason: QadamSignatureUnverified.NOT_RECORDED, exempt: false })
    })

    it('warns once, not once per version, when the ledger is unusable', async () => {
        await writeFile(ledgerFile, 'garbage')
        const versions = Array.from({ length: 4 }, (_, index) => storedVersion({ name: `@aiqadam/qadam-n${index}`, version: '1.0.0', tarballIntegrity: `sha512-${index}` }))

        const checks = await ledger.checkStoredVersions({ versions })

        expect(log.warn).toHaveBeenCalledTimes(1)
        expect(checks.every((check) => !check.verified && check.reason === QadamSignatureUnverified.LEDGER_UNUSABLE)).toBe(true)
    })

    it('does not read the ledger at all when no version needs a signature', async () => {
        const seed = storedVersion({ name: '@aiqadam/qadam-seed', version: '1.0.0', tarballIntegrity: 'sha512-seed', origin: QadamVersionOrigin.IMAGE_SEED })
        const custom = storedVersion({ platformId: 'AAAAAAAAAAAAAAAAAAAAA', name: 'acme', version: '1.0.0', tarballIntegrity: 'sha512-acme', origin: QadamVersionOrigin.ARCHIVE })

        const checks = await ledger.checkStoredVersions({ versions: [seed, custom] })

        expect(control.reads).toBe(0)
        expect(checks).toEqual([
            { verified: false, reason: QadamSignatureUnverified.IMAGE_SEED, exempt: true },
            { verified: false, reason: QadamSignatureUnverified.NOT_OFFICIAL, exempt: true },
        ])
    })

    it('exempts an image seed whatever integrity it carries, and a recorded signature changes nothing for it', async () => {
        const seed = storedVersion({ name: TABLES.name, version: TABLES.version, tarballIntegrity: TABLES.integrity, origin: QadamVersionOrigin.IMAGE_SEED })
        await ledger.record({ proofs: [proofFor(TABLES)] })

        expect(await ledger.checkStored({ version: seed })).toEqual({ verified: false, reason: QadamSignatureUnverified.IMAGE_SEED, exempt: true })
    })

    it('does not exempt a fetched or uploaded official version', async () => {
        const fetched = storedVersion({ name: TABLES.name, version: TABLES.version, tarballIntegrity: TABLES.integrity, origin: QadamVersionOrigin.REGISTRY })
        const uploaded = storedVersion({ name: TABLES.name, version: TABLES.version, tarballIntegrity: null, origin: QadamVersionOrigin.ARCHIVE })

        expect(await ledger.checkStored({ version: fetched })).toEqual({ verified: false, reason: QadamSignatureUnverified.NOT_RECORDED, exempt: false })
        expect(await ledger.checkStored({ version: uploaded })).toEqual({ verified: false, reason: QadamSignatureUnverified.NO_TARBALL_INTEGRITY, exempt: false })
    })
})

function proofFor(pkg: { name: string, version: string, integrity: string }): { name: string, version: string, integrity: string, signatures: { keyid: string, sig: string }[] } {
    return { ...pkg, signatures: [{ keyid: KEY_ID, sig: signWith({ pkg, key: privateKey }) }] }
}

function signWith({ pkg, key }: { pkg: { name: string, version: string, integrity: string }, key: KeyObject }): string {
    return sign('sha256', Buffer.from(`${pkg.name}@${pkg.version}:${pkg.integrity}`), key).toString('base64')
}

function storedVersion({ platformId = null, name, version, tarballIntegrity, origin = QadamVersionOrigin.REGISTRY }: { platformId?: string | null, name: string, version: string, tarballIntegrity: string | null, origin?: QadamVersionOrigin }): StoredQadamVersion {
    return {
        coordinates: { platformId, name, version },
        dir: join(dir, name, version),
        entryPointPath: join(dir, name, version, 'index.js'),
        metadataPath: join(dir, name, version, 'metadata.json'),
        format: QadamArtifactFormat.BUNDLE,
        kind: null,
        integrity: {
            storeFormatVersion: 1,
            platformId,
            name,
            version,
            format: QadamArtifactFormat.BUNDLE,
            kind: null,
            entryPoint: 'index.js',
            origin: { kind: origin, tarballIntegrity },
            tree: { algorithm: 'sha512', digest: 'sha512-x', files: 1, bytes: 1 },
            storedAt: new Date().toISOString(),
        },
    }
}
