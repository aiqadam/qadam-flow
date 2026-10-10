import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { z } from 'zod'
import { fileSystemUtils } from '../file-system-utils'
import { npmPackageSignature, NpmPackageSignature, NpmTrustedKeys } from '../npm-package-signature'
import { qadamVersionStoreFs } from './qadam-version-store-fs'
import { QADAM_VERSION_STORE_LAYOUT } from './qadam-version-store-layout'
import type { StoredQadamVersion } from './qadam-version-store-read'

export enum QadamSignatureUnverified {
    // The ledger has no record for this name, version and integrity.
    NOT_RECORDED = 'not-recorded',
    // The ledger file is present but unusable (corrupt, oversized, not a regular file, or written by
    // a later release).
    LEDGER_UNUSABLE = 'ledger-unusable',
    // A record exists and its signature does not verify for this name, version and integrity.
    SIGNATURE_DOES_NOT_VERIFY = 'signature-does-not-verify',
    // A stored version the store did not take from a tarball (an image seed, an archive): nothing
    // npmjs signed is bound to it.
    NO_TARBALL_INTEGRITY = 'no-tarball-integrity',
    // A custom qadam: npmjs signs nothing of it.
    NOT_OFFICIAL = 'not-official',
}

// The npm signatures already verified for official qadam versions, kept beside what they cover so a
// restart does not ask the registry again (#780, ADR-0003: the signature is mandatory for
// `@aiqadam/*`, and everything already in the store must keep running without network).
//
// What is stored is the PROOF, not a verdict. A record is `(name, version, integrity)` plus the
// signature npmjs made over exactly that string, and every lookup verifies that signature again,
// locally, against the keys this platform pins (`npmPackageSignature`). So the file is a cache the
// registry's answer can be rebuilt from, and nothing in it is trusted:
//
// - a record whose signature, integrity, name or version was edited fails verification and the
//   package is asked of the registry again, which offline is the same fail-closed refusal as before;
// - a different tarball has a different integrity, so no record matches it, whatever the file says;
// - a signature copied from another package or version does not verify for this one;
// - a record whose key npm has since rotated out of the pinned set stops verifying, like the online
//   check would;
// - a deleted, corrupt, truncated or oversized file is an empty ledger, never an error that lets a
//   package through or one that fails an install the registry could still verify.
//
// What it does not protect: it says npmjs signed these bytes, not that the bytes on disk are those
// bytes. For a stored version that gap is the store's own record (`checkStored` compares the
// integrity of the tarball the store extracted, which the store recorded and `read({ verify: true })`
// holds the files to), which a writer of the store directory can edit as freely as the files. The
// store is written by the app only and mounted read-only on workers (#779), as before.
//
// Where it lives: the directory the caller names. For the qadam version store that is the store's
// root (`QADAM_VERSION_STORE_LAYOUT.signatureLedgerFile`); the worker keeps its own beside the
// `bun.lock` it verifies. It is not part of any version, so a version's digest and `integrity.json`
// are unchanged, and a release that does not know this file does not read or break on it.
//
// Writes are atomic (a unique temporary file in the same directory, flushed, renamed over the
// ledger) and merge with whatever is on disk at that moment, so two replicas recording at once can
// at worst lose a record, which costs one registry read later. A ledger written by a LATER format
// is read as empty and never overwritten: another release sharing the volume can still use it.
export const qadamSignatureLedger = {
    open: ({ dir, log, trustedKeys, maxEntries = DEFAULT_MAX_ENTRIES }: OpenParams): QadamSignatureLedger => {
        const filePath = path.join(dir, QADAM_VERSION_STORE_LAYOUT.signatureLedgerFile)

        const check = async ({ packages }: { packages: QadamSignedPackage[] }): Promise<QadamSignatureCheckResult> => {
            const ledger = await readLedger({ filePath })
            const byKey = new Map(ledger.ok ? ledger.entries.map((entry) => [tripleKey(entry), entry]) : [])
            const results = packages.map((pkg): { pkg: QadamSignedPackage, reason: QadamSignatureUnverified | null } => {
                const entry = byKey.get(tripleKey(pkg))
                if (isNil(entry)) {
                    return { pkg, reason: ledger.ok ? QadamSignatureUnverified.NOT_RECORDED : QadamSignatureUnverified.LEDGER_UNUSABLE }
                }
                const verifying = npmPackageSignature.verifying({ ...pkg, signatures: entry.signatures, trustedKeys })
                return { pkg, reason: verifying.length > 0 ? null : QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY }
            })
            const unverified = results.flatMap(({ pkg, reason }) => isNil(reason) ? [] : [{ package: pkg, reason }])
            if (!ledger.ok) {
                log.warn({ reason: ledger.reason }, '[qadamSignatureLedger] The persisted signatures cannot be used, so every package is verified against the registry')
            }
            const rejected = unverified.filter(({ reason }) => reason === QadamSignatureUnverified.SIGNATURE_DOES_NOT_VERIFY)
            if (rejected.length > 0) {
                log.warn({ count: rejected.length, packages: rejected.slice(0, MAX_LOGGED_PACKAGES).map(({ package: pkg }) => `${pkg.name}@${pkg.version}`) }, '[qadamSignatureLedger] A persisted signature does not verify any more (edited, or its key is no longer pinned), so the registry is asked again')
            }
            return {
                verified: results.flatMap(({ pkg, reason }) => isNil(reason) ? [pkg] : []),
                unverified,
            }
        }

        const checkStored = async ({ version }: { version: StoredQadamVersion }): Promise<QadamSignatureCheck> => {
            const { platformId, name, version: versionNumber, origin } = version.integrity
            // Only an official qadam the store took from a tarball has a signature to bind to.
            if (!isNil(platformId)) {
                return { verified: false, reason: QadamSignatureUnverified.NOT_OFFICIAL }
            }
            if (isNil(origin.tarballIntegrity)) {
                return { verified: false, reason: QadamSignatureUnverified.NO_TARBALL_INTEGRITY }
            }
            const checked = await check({ packages: [{ name, version: versionNumber, integrity: origin.tarballIntegrity }] })
            const [unverified] = checked.unverified
            return isNil(unverified) ? { verified: true } : { verified: false, reason: unverified.reason }
        }

        const record = async ({ proofs }: { proofs: QadamSignatureProof[] }): Promise<QadamSignatureRecordResult> => {
            const now = new Date().toISOString()
            // Only signatures that verify are kept, and only a few: nothing the registry sent beyond
            // the proof is worth a byte of the file.
            const proven = proofs.flatMap((proof): LedgerEntry[] => {
                const signatures = uniqueSignatures({ signatures: npmPackageSignature.verifying({ ...proof, trustedKeys }) }).slice(0, MAX_SIGNATURES_PER_ENTRY)
                return signatures.length === 0 ? [] : [{ name: proof.name, version: proof.version, integrity: proof.integrity, signatures, verifiedAt: now }]
            })
            const rejected = proofs.length - proven.length
            if (proven.length === 0) {
                return { ok: true, recorded: 0, rejected }
            }
            const current = await readLedger({ filePath })
            if (!current.ok && current.newerFormat) {
                return { ok: false, reason: current.reason }
            }
            const merged = mergeEntries({ current: current.ok ? current.entries : [], added: proven, maxEntries })
            const written = await tryCatch(() => writeLedger({ dir, filePath, entries: merged }))
            if (written.error !== null) {
                return { ok: false, reason: `the ledger cannot be written (${qadamVersionStoreFs.describeErrorCode({ error: written.error })})` }
            }
            return { ok: true, recorded: proven.length, rejected }
        }

        return { filePath, check, checkStored, record }
    },
}

// Read as empty rather than refused past this: it is a cache, and the registry can always answer
// again. A year of official qadams is a few thousand records of about 600 bytes.
const MAX_LEDGER_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 20_000
const MAX_SIGNATURES_PER_ENTRY = 4
const MAX_LOGGED_PACKAGES = 10
const LEDGER_FORMAT_VERSION = 1

const LedgerEntry = z.object({
    name: z.string(),
    version: z.string(),
    integrity: z.string(),
    signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })),
    verifiedAt: z.string(),
})

const LedgerFile = z.object({
    formatVersion: z.literal(LEDGER_FORMAT_VERSION),
    entries: z.array(z.unknown()),
})

const LedgerEnvelope = z.object({ formatVersion: z.number().int().positive() }).loose()

// A JSON array, not a string join: no name, version or integrity can be spelled so that two
// different triples share a key.
function tripleKey({ name, version, integrity }: QadamSignedPackage): string {
    return JSON.stringify([name, version, integrity])
}

function uniqueSignatures({ signatures }: { signatures: NpmPackageSignature[] }): NpmPackageSignature[] {
    return [...new Map(signatures.map((signature) => [`${signature.keyid}\0${signature.sig}`, signature])).values()]
}

// The newest `maxEntries` by verification time; a record for the same triple is replaced by the new one.
function mergeEntries({ current, added, maxEntries }: { current: LedgerEntry[], added: LedgerEntry[], maxEntries: number }): LedgerEntry[] {
    const byKey = new Map([...current, ...added].map((entry) => [tripleKey(entry), entry]))
    return [...byKey.values()].sort((a, b) => a.verifiedAt < b.verifiedAt ? -1 : a.verifiedAt > b.verifiedAt ? 1 : 0).slice(-maxEntries)
}

async function readLedger({ filePath }: { filePath: string }): Promise<LedgerRead> {
    const stats = await tryCatch(() => lstat(filePath))
    if (stats.error !== null) {
        return fileSystemUtils.hasErrorCode({ error: stats.error, code: 'ENOENT' })
            ? { ok: true, entries: [] }
            : unusable({ reason: `the ledger cannot be read (${qadamVersionStoreFs.describeErrorCode({ error: stats.error })})` })
    }
    if (!stats.data.isFile()) {
        return unusable({ reason: 'the ledger is not a regular file' })
    }
    if (stats.data.size > MAX_LEDGER_BYTES) {
        return unusable({ reason: `the ledger is larger than ${MAX_LEDGER_BYTES} bytes` })
    }
    const content = await tryCatch(() => readFile(filePath, 'utf8'))
    if (content.error !== null) {
        return unusable({ reason: `the ledger cannot be read (${qadamVersionStoreFs.describeErrorCode({ error: content.error })})` })
    }
    const parsed = await tryCatch(async (): Promise<unknown> => JSON.parse(content.data))
    if (parsed.error !== null) {
        return unusable({ reason: 'the ledger is not valid JSON' })
    }
    const envelope = LedgerEnvelope.safeParse(parsed.data)
    if (!envelope.success) {
        return unusable({ reason: 'the ledger is not a signature ledger' })
    }
    if (envelope.data.formatVersion > LEDGER_FORMAT_VERSION) {
        return unusable({ reason: `the ledger is format ${envelope.data.formatVersion}, written by a later release`, newerFormat: true })
    }
    const file = LedgerFile.safeParse(parsed.data)
    if (!file.success) {
        return unusable({ reason: 'the ledger is not a signature ledger' })
    }
    // One bad record is dropped, not the whole file: the others are still proofs.
    const entries = file.data.entries.flatMap((raw) => {
        const entry = LedgerEntry.safeParse(raw)
        return entry.success ? [entry.data] : []
    })
    return { ok: true, entries }
}

function unusable({ reason, newerFormat = false }: { reason: string, newerFormat?: boolean }): LedgerRead {
    return { ok: false, reason, newerFormat }
}

// A unique temporary name, so two replicas never write the same file; the rename is the commit.
async function writeLedger({ dir, filePath, entries }: { dir: string, filePath: string, entries: LedgerEntry[] }): Promise<void> {
    const temporary = path.join(dir, `.${QADAM_VERSION_STORE_LAYOUT.signatureLedgerFile}.${randomUUID()}.tmp`)
    const written = await tryCatch(async () => {
        const handle = await open(temporary, 'wx', 0o644)
        try {
            await handle.writeFile(JSON.stringify({ formatVersion: LEDGER_FORMAT_VERSION, entries }) + '\n')
            await handle.datasync()
        }
        finally {
            await handle.close()
        }
        await rename(temporary, filePath)
    })
    if (written.error !== null) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw written.error
    }
    await syncDirectory({ dir })
}

// Best effort: the rename is already visible; this makes it survive a power cut.
async function syncDirectory({ dir }: { dir: string }): Promise<void> {
    const handle = await tryCatch(() => open(dir, 'r'))
    if (handle.error !== null) {
        return
    }
    await handle.data.datasync().catch(() => undefined)
    await handle.data.close().catch(() => undefined)
}

export type QadamSignedPackage = {
    name: string
    version: string
    // The `dist.integrity` npmjs signed: `sha512-<base64>`.
    integrity: string
}

export type QadamSignatureProof = QadamSignedPackage & {
    signatures: NpmPackageSignature[]
}

export type QadamSignatureCheck = { verified: true } | { verified: false, reason: QadamSignatureUnverified }

export type QadamSignatureCheckResult = {
    verified: QadamSignedPackage[]
    unverified: { package: QadamSignedPackage, reason: QadamSignatureUnverified }[]
}

export type QadamSignatureRecordResult =
    | { ok: true, recorded: number, rejected: number }
    | { ok: false, reason: string }

export type QadamSignatureLedgerLogger = {
    warn: (obj: Record<string, unknown>, msg: string) => void
}

export type QadamSignatureLedger = {
    filePath: string
    // Which of these packages the persisted signatures cover, verified again offline. Never reads the
    // registry, never throws; the rest must be verified another way.
    check: (params: { packages: QadamSignedPackage[] }) => Promise<QadamSignatureCheckResult>
    // The same for a stored version, bound to the integrity of the tarball the store extracted for it.
    checkStored: (params: { version: StoredQadamVersion }) => Promise<QadamSignatureCheck>
    // Persists the signatures that verify for each proof and drops every other one. Never throws: a
    // ledger that cannot be written costs a registry read after the next restart, nothing else.
    record: (params: { proofs: QadamSignatureProof[] }) => Promise<QadamSignatureRecordResult>
}

type OpenParams = {
    dir: string
    log: QadamSignatureLedgerLogger
    // Only for a test: production callers get the pinned npmjs keys.
    trustedKeys?: NpmTrustedKeys
    maxEntries?: number
}

type LedgerEntry = z.infer<typeof LedgerEntry>

type LedgerRead =
    | { ok: true, entries: LedgerEntry[] }
    | { ok: false, reason: string, newerFormat: boolean }
