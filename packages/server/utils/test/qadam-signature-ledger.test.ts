import { generateKeyPairSync, KeyObject, sign } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { npmPackageSignature, NpmPackageSignature, NpmTrustedKeys } from '../src/npm-package-signature'
import { QadamSignatureLedger, qadamSignatureLedger, QadamSignatureProof, QadamSignatureUnverified } from '../src/qadam-version-store/qadam-signature-ledger'

// The ledger verifies every persisted signature again against the keys it is given, so these tests
// sign with a key of their own and trust it. (The pinned npmjs key is exercised against npmjs's real
// output in the worker's `qadam-integrity.test.ts`.)
const KEY_ID = 'SHA256:test-signing-key'
const OTHER_KEY_ID = 'SHA256:another-key'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const TRUSTED: NpmTrustedKeys = { [KEY_ID]: spki(publicKey) }

const TABLES = { name: '@aiqadam/qadam-tables', version: '0.5.1', integrity: 'sha512-AAAA' }
const CSV = { name: '@aiqadam/qadam-csv', version: '0.6.0', integrity: 'sha512-BBBB' }
const log = { warn: vi.fn() }

let dir: string
let ledgerFile: string

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-signature-ledger-')))
    ledgerFile = join(dir, 'qadam-signatures.json')
    log.warn.mockClear()
})

afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
})

describe('qadamSignatureLedger', () => {
    it('answers for a package a previous process recorded, without anything but the file', async () => {
        const first = openLedger()
        const recorded = await first.record({ proofs: [proofFor(TABLES), proofFor(CSV)] })
        expect(recorded).toEqual({ ok: true, recorded: 2, rejected: 0 })

        const afterRestart = openLedger()
        const checked = await afterRestart.check({ packages: [TABLES, CSV] })

        expect(checked.verified).toEqual([TABLES, CSV])
        expect(checked.unverified).toEqual([])
    })

    it('has no answer for a package it never recorded, and none for the same version with other bytes', async () => {
        await openLedger().record({ proofs: [proofFor(TABLES)] })

        const checked = await openLedger().check({ packages: [CSV, { ...TABLES, integrity: 'sha512-CCCC' }] })

        expect(checked.verified).toEqual([])
        expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.NOT_RECORDED, QadamSignatureUnverified.NOT_RECORDED])
    })

    it('is empty, not an error, when nothing was ever recorded', async () => {
        const checked = await openLedger().check({ packages: [TABLES] })

        expect(checked.unverified).toEqual([{ package: TABLES, reason: QadamSignatureUnverified.NOT_RECORDED }])
        expect(log.warn).not.toHaveBeenCalled()
    })

    it('refuses to record a signature that does not verify, and writes nothing for it', async () => {
        const foreign = { ...TABLES, signatures: [signatureFor({ ...TABLES, key: other.privateKey, keyid: OTHER_KEY_ID })] }
        const wrongVersion = { ...TABLES, signatures: [signatureFor({ ...TABLES, version: '0.5.0' })] }
        const wrongBytes = { ...TABLES, signatures: [signatureFor({ ...TABLES, integrity: 'sha512-ZZZZ' })] }
        const forged = { ...TABLES, signatures: [{ keyid: KEY_ID, sig: Buffer.from('not a signature').toString('base64') }] }

        const result = await openLedger().record({ proofs: [foreign, wrongVersion, wrongBytes, forged, { ...TABLES, signatures: [] }] })

        expect(result).toEqual({ ok: true, recorded: 0, rejected: 5 })
        await expect(readFile(ledgerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('keeps only the signatures that verify, once each, and no more than four', async () => {
        const good = signatureFor(TABLES)
        // ECDSA is randomised: every signature over the same payload is different, and all verify.
        const others = Array.from({ length: 6 }, () => signatureFor(TABLES))

        await openLedger().record({ proofs: [{ ...TABLES, signatures: [good, good, ...others, { keyid: OTHER_KEY_ID, sig: good.sig }] }] })

        const [entry] = (await readLedgerFile()).entries
        expect(entry?.signatures).toHaveLength(4)
        expect(entry?.signatures[0]).toEqual(good)
        expect(new Set(entry?.signatures.map(({ sig }) => sig)).size).toBe(4)
        expect(npmPackageSignature.verifying({ ...TABLES, signatures: entry?.signatures ?? [], trustedKeys: TRUSTED })).toHaveLength(4)
    })

    describe('a record that was edited', () => {
        beforeEach(async () => {
            await openLedger().record({ proofs: [proofFor(TABLES), proofFor(CSV)] })
        })

        it('does not verify once its signature is replaced with another package\'s', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, signatures: proofFor(CSV).signatures }) })

            const checked = await openLedger().check({ packages: [TABLES, CSV] })

            expect(checked.verified).toEqual([CSV])
            expect(checked.unverified).toEqual([{ package: TABLES, reason: QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY }])
            expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ count: 1, packages: [`${TABLES.name}@${TABLES.version}`] }), expect.stringContaining('does not verify any more'))
        })

        it('does not verify once the integrity it is filed under is changed to other bytes', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, integrity: 'sha512-EVIL' }) })

            const checked = await openLedger().check({ packages: [{ ...TABLES, integrity: 'sha512-EVIL' }, TABLES] })

            expect(checked.verified).toEqual([])
            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY, QadamSignatureUnverified.NOT_RECORDED])
        })

        it('does not verify once the version it is filed under is changed', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, version: '0.5.2' }) })

            const checked = await openLedger().check({ packages: [{ ...TABLES, version: '0.5.2' }] })

            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY])
        })

        it('does not verify with a flipped bit in the signature or a signature that is not base64', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, signatures: [{ keyid: KEY_ID, sig: flipFirstByte({ base64: proofFor(TABLES).signatures[0].sig }) }] }) })
            await editEntry({ name: CSV.name, change: (entry) => ({ ...entry, signatures: [{ keyid: KEY_ID, sig: '!!!' }] }) })

            const checked = await openLedger().check({ packages: [TABLES, CSV] })

            expect(checked.verified).toEqual([])
            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY, QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY])
        })

        it('does not verify when it claims a key the platform does not trust', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, signatures: [{ keyid: OTHER_KEY_ID, sig: proofFor(TABLES).signatures[0].sig }] }) })

            const checked = await openLedger().check({ packages: [TABLES] })

            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY])
        })

        it('does not verify a key id that is an inherited property name', async () => {
            await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, signatures: [{ keyid: 'constructor', sig: proofFor(TABLES).signatures[0].sig }] }) })

            const checked = await openLedger().check({ packages: [TABLES] })

            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY])
        })

        it('is dropped on its own, leaving the other records usable, when it has the wrong shape', async () => {
            const file = await readLedgerFile()
            await writeFile(ledgerFile, JSON.stringify({ ...file, entries: [{ name: TABLES.name }, 7, null, ...file.entries.filter((entry: { name: string }) => entry.name === CSV.name)] }))

            const checked = await openLedger().check({ packages: [TABLES, CSV] })

            expect(checked.verified).toEqual([CSV])
            expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.NOT_RECORDED])
        })
    })

    it('stops answering for a record whose signing key is no longer trusted', async () => {
        await openLedger().record({ proofs: [proofFor(TABLES)] })

        const rotated = qadamSignatureLedger.open({ dir, log, trustedKeys: { [OTHER_KEY_ID]: spki(other.publicKey) } })
        const checked = await rotated.check({ packages: [TABLES] })

        expect(checked.unverified.map(({ reason }) => reason)).toEqual([QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY])
    })

    describe('a ledger file that cannot be used', () => {
        it.each([
            ['is not JSON', (): Promise<void> => writeFile(ledgerFile, '{"formatVersion": 1, "entr')],
            ['is empty', (): Promise<void> => writeFile(ledgerFile, '')],
            ['is another JSON document', (): Promise<void> => writeFile(ledgerFile, JSON.stringify(['a']))],
            ['has no entries list', (): Promise<void> => writeFile(ledgerFile, JSON.stringify({ formatVersion: 1 }))],
            ['is larger than the ledger ever is', (): Promise<void> => writeFile(ledgerFile, ' '.repeat(16 * 1024 * 1024 + 1))],
            ['is a directory', async (): Promise<void> => {
                await mkdir(ledgerFile) 
            }],
            ['is a symlink', async (): Promise<void> => {
                await writeFile(join(dir, 'real.json'), JSON.stringify({ formatVersion: 1, entries: [] }))
                await symlink(join(dir, 'real.json'), ledgerFile)
            }],
        ])('is empty, with a warning, when it %s', async (_label, arrange) => {
            await arrange()

            const checked = await openLedger().check({ packages: [TABLES] })

            expect(checked.verified).toEqual([])
            expect(checked.unverified).toEqual([{ package: TABLES, reason: QadamSignatureUnverified.LEDGER_UNUSABLE }])
            expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.any(String) }), expect.stringContaining('cannot be used'))
        })

        it('is replaced by the next record when it is corrupt', async () => {
            await writeFile(ledgerFile, 'garbage')

            const recorded = await openLedger().record({ proofs: [proofFor(TABLES)] })

            expect(recorded).toEqual({ ok: true, recorded: 1, rejected: 0 })
            expect((await openLedger().check({ packages: [TABLES] })).verified).toEqual([TABLES])
        })

        it('is read as empty and never overwritten when a later release wrote it', async () => {
            const later = JSON.stringify({ formatVersion: 2, entries: [], somethingNew: true })
            await writeFile(ledgerFile, later)

            const checked = await openLedger().check({ packages: [TABLES] })
            const recorded = await openLedger().record({ proofs: [proofFor(TABLES)] })

            expect(checked.unverified).toEqual([{ package: TABLES, reason: QadamSignatureUnverified.LEDGER_UNUSABLE }])
            expect(recorded).toEqual({ ok: false, reason: 'the ledger is format 2, written by a later release' })
            expect(await readFile(ledgerFile, 'utf8')).toBe(later)
        })
    })

    describe('writing', () => {
        it('leaves the previous ledger and no temporary file when the write cannot complete', async () => {
            await mkdir(ledgerFile)

            const recorded = await openLedger().record({ proofs: [proofFor(TABLES)] })

            expect(recorded.ok).toBe(false)
            expect(await readdir(dir)).toEqual(['qadam-signatures.json'])
        })

        it('reports a directory it cannot write to, and does not throw', async () => {
            const missing = qadamSignatureLedger.open({ dir: join(dir, 'does-not-exist'), log, trustedKeys: TRUSTED })

            const recorded = await missing.record({ proofs: [proofFor(TABLES)] })

            expect(recorded).toEqual({ ok: false, reason: 'the ledger cannot be written (ENOENT)' })
        })

        it('writes a world-readable regular file and leaves no temporary file behind', async () => {
            await openLedger().record({ proofs: [proofFor(TABLES)] })
            await openLedger().record({ proofs: [proofFor(CSV)] })

            expect(await readdir(dir)).toEqual(['qadam-signatures.json'])
            expect((await stat(ledgerFile)).mode & 0o777).toBe(0o644)
        })

        it('adds to what is there and replaces a record for the same package', async () => {
            await openLedger().record({ proofs: [proofFor(TABLES)] })
            await openLedger().record({ proofs: [proofFor(CSV), proofFor(TABLES)] })

            const file = await readLedgerFile()

            expect(file.entries.map((entry: { name: string }) => entry.name).sort()).toEqual([CSV.name, TABLES.name])
        })

        it('keeps the newest records when it would hold more than it is allowed', async () => {
            const small = qadamSignatureLedger.open({ dir, log, trustedKeys: TRUSTED, maxEntries: 2 })
            const third = { name: '@aiqadam/qadam-http', version: '1.0.0', integrity: 'sha512-DDDD' }
            await small.record({ proofs: [proofFor(TABLES)] })
            await small.record({ proofs: [proofFor(CSV)] })
            await small.record({ proofs: [proofFor(third)] })

            const checked = await small.check({ packages: [TABLES, CSV, third] })

            expect(checked.verified).toEqual([CSV, third])
            expect(checked.unverified.map(({ package: pkg }) => pkg)).toEqual([TABLES])
        })
    })

    it('is readable by a later release that adds a field to a record', async () => {
        await openLedger().record({ proofs: [proofFor(TABLES)] })
        await editEntry({ name: TABLES.name, change: (entry) => ({ ...entry, publishedBy: 'someone' }) })

        expect((await openLedger().check({ packages: [TABLES] })).verified).toEqual([TABLES])
    })
})

describe('npmPackageSignature', () => {
    it('reads the signatures of a registry version document and ignores anything malformed', () => {
        const versionDocument = { dist: { signatures: [{ keyid: 'a', sig: 'b' }, { keyid: 1, sig: 'c' }, { sig: 'd' }, null, 'x'] } }

        expect(npmPackageSignature.readSignatures({ versionDocument })).toEqual([{ keyid: 'a', sig: 'b' }])
        expect(npmPackageSignature.readSignatures({ versionDocument: { dist: {} } })).toEqual([])
        expect(npmPackageSignature.readSignatures({ versionDocument: null })).toEqual([])
        expect(npmPackageSignature.readSignatures({ versionDocument: { dist: { signatures: 'nope' } } })).toEqual([])
    })

    it('verifies for exactly the name, version and integrity that were signed', () => {
        const signatures = [signatureFor(TABLES)]

        expect(npmPackageSignature.verifying({ ...TABLES, signatures, trustedKeys: TRUSTED })).toEqual(signatures)
        for (const changed of [{ name: CSV.name }, { version: '0.5.2' }, { integrity: 'sha512-CCCC' }]) {
            expect(npmPackageSignature.verifying({ ...TABLES, ...changed, signatures, trustedKeys: TRUSTED })).toEqual([])
        }
    })

    it('trusts only the npmjs key it pins unless it is given others', () => {
        const signatures = [signatureFor(TABLES)]

        expect(npmPackageSignature.verifying({ ...TABLES, signatures })).toEqual([])
        expect(npmPackageSignature.pinned({ signatures })).toEqual([])
        expect(npmPackageSignature.pinned({ signatures: [{ keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U', sig: 'x' }] })).toHaveLength(1)
    })
})

function openLedger(): QadamSignatureLedger {
    return qadamSignatureLedger.open({ dir, log, trustedKeys: TRUSTED })
}

function proofFor(pkg: { name: string, version: string, integrity: string }): QadamSignatureProof {
    return { ...pkg, signatures: [signatureFor(pkg)] }
}

function signatureFor({ name, version, integrity, key = privateKey, keyid = KEY_ID }: { name: string, version: string, integrity: string, key?: KeyObject, keyid?: string }): NpmPackageSignature {
    const payload = Buffer.from(`${name}@${version}:${integrity}`)
    return { keyid, sig: sign('sha256', payload, key).toString('base64') }
}

function spki(key: KeyObject): string {
    return key.export({ type: 'spki', format: 'der' }).toString('base64')
}

function flipFirstByte({ base64 }: { base64: string }): string {
    const bytes = Buffer.from(base64, 'base64')
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
    return bytes.toString('base64')
}

async function readLedgerFile(): Promise<{ formatVersion: number, entries: { name: string, signatures: NpmPackageSignature[] }[] }> {
    return JSON.parse(await readFile(ledgerFile, 'utf8'))
}

async function editEntry({ name, change }: { name: string, change: (entry: Record<string, unknown>) => Record<string, unknown> }): Promise<void> {
    const file = await readLedgerFile()
    await writeFile(ledgerFile, JSON.stringify({ ...file, entries: file.entries.map((entry) => entry.name === name ? change(entry) : entry) }))
}
