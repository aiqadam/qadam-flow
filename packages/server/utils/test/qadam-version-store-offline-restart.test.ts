import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NpmPackageSignature, npmPackageSignature, NpmTrustedKeys } from '../src/npm-package-signature'
import { QadamSignatureLedger, qadamSignatureLedger, QadamSignatureUnverified } from '../src/qadam-version-store/qadam-signature-ledger'
import { QadamVersionOrigin, QadamVersionPutStatus, QadamVersionReadStatus, qadamVersionStore, QadamVersionStore } from '../src/qadam-version-store/qadam-version-store'
import { QadamVersionCoordinates, qadamVersionStoreLayout } from '../src/qadam-version-store/qadam-version-store-layout'
import { qadamVersionStoreReader } from '../src/qadam-version-store/qadam-version-store-read'
import { tarFixtures } from './qadam-version-store-fixtures'

// #780 item 4: no outbound network, a warm volume, a restart: what the store holds, and what was
// already verified for it, still works.
//
// What this is not: a worker process restarted in Docker. The store and the signature ledger are the
// whole of what a restart keeps on the volume, so the restart here is the part of one a unit test
// can reach: every object is dropped, the store and the ledger are opened again from the same
// directory, and the "registry" is a fake that fails the test's expectation on ANY call. The real
// verification pass of the worker (which also reads a `bun.lock`) is restarted the same way in
// `packages/server/worker/test/lib/cache/qadams/qadam-integrity.test.ts`.
const KEY_ID = 'SHA256:test-signing-key'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const TRUSTED: NpmTrustedKeys = { [KEY_ID]: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
const CSV = { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0' }
const TABLES = { platformId: null, name: '@aiqadam/qadam-tables', version: '0.5.1' }
const SEEDED = { platformId: null, name: '@aiqadam/qadam-delay', version: '1.2.0' }
const log = { info: vi.fn(), warn: vi.fn() }

let tempDir: string
let root: string
let registry: FakeRegistry

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-offline-restart-')))
    root = join(tempDir, 'store')
    registry = fakeRegistry()
})

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
})

describe('a restart with no network and a warm volume', () => {
    it('runs every stored version and re-verifies the registry\'s signatures without a single registry call', async () => {
        await warmTheVolume()
        registry.goOffline()

        const sweep = await restartAndSweep()

        expect(sweep).toEqual([
            { qadam: '@aiqadam/qadam-csv@0.6.0', outcome: 'verified' },
            { qadam: '@aiqadam/qadam-delay@1.2.0', outcome: 'image-seed' },
            { qadam: '@aiqadam/qadam-tables@0.5.1', outcome: 'verified' },
        ])
        expect(registry.calls).toBe(0)
    })

    it('loads the stored versions through the read-only reader a worker uses', async () => {
        await warmTheVolume()
        registry.goOffline()

        const opened = await qadamVersionStoreReader.open({ root })
        if (!opened.ok) {
            throw new Error(opened.reason)
        }

        for (const coordinates of [CSV, TABLES, SEEDED]) {
            const read = await opened.reader.read({ coordinates, verify: true })
            expect(read.status).toBe(QadamVersionReadStatus.PRESENT)
        }
        expect(registry.calls).toBe(0)
    })

    describe('what the persisted signatures do not excuse', () => {
        it('asks the registry again, and fails closed offline, when the ledger was lost', async () => {
            await warmTheVolume()
            await rm(join(root, 'qadam-signatures.json'))
            registry.goOffline()

            const sweep = await restartAndSweep()

            expect(sweep.filter(({ outcome }) => outcome === 'refused: registry unreachable').map(({ qadam }) => qadam)).toEqual(['@aiqadam/qadam-csv@0.6.0', '@aiqadam/qadam-tables@0.5.1'])
            expect(registry.calls).toBe(2)
        })

        it('asks the registry again for a version that was stored but never verified', async () => {
            await warmTheVolume()
            const fetchedWhileOnline = await storeFromRegistry({ coordinates: { ...CSV, version: '0.6.1' }, signed: false })
            expect(fetchedWhileOnline).toBe(QadamVersionPutStatus.STORED)
            registry.goOffline()

            const sweep = await restartAndSweep()

            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.1')?.outcome).toBe('refused: registry unreachable')
            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.0')?.outcome).toBe('verified')
            expect(registry.calls).toBe(1)
        })

        it('does not accept a stored version whose recorded tarball integrity was edited to another one the registry signed', async () => {
            await warmTheVolume()
            const tablesIntegrity = await readIntegrityFile({ coordinates: TABLES })
            await editIntegrityFile({ coordinates: CSV, change: (record) => ({ ...record, origin: { ...record.origin, tarballIntegrity: tablesIntegrity.origin.tarballIntegrity } }) })
            registry.goOffline()

            const sweep = await restartAndSweep()

            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.0')?.outcome).toBe('refused: registry unreachable')
        })

        it('does not accept an edited tarball integrity even from a reachable registry, which signed the real one', async () => {
            await warmTheVolume()
            const tablesIntegrity = await readIntegrityFile({ coordinates: TABLES })
            await editIntegrityFile({ coordinates: CSV, change: (record) => ({ ...record, origin: { ...record.origin, tarballIntegrity: tablesIntegrity.origin.tarballIntegrity } }) })

            const sweep = await restartAndSweep()

            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.0')?.outcome).toBe('refused: not signed by the registry')
        })

        it('does not accept a stored version whose files changed, whatever the ledger says', async () => {
            await warmTheVolume()
            await writeFile(join(root, 'qadams', '@aiqadam', 'qadam-csv', '0.6.0', 'src', 'index.js'), 'exports.evil = true\n')
            registry.goOffline()

            const sweep = await restartAndSweep()

            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.0')?.outcome).toBe('damaged')
            expect(registry.calls).toBe(0)
        })

        it('does not accept a signature filed for one version under another', async () => {
            await warmTheVolume()
            const ledgerFile = join(root, 'qadam-signatures.json')
            const ledger: { entries: { name: string, signatures: NpmPackageSignature[] }[] } = JSON.parse(await readFile(ledgerFile, 'utf8'))
            const tablesSignatures = ledger.entries.find((entry) => entry.name === TABLES.name)?.signatures ?? []
            await writeFile(ledgerFile, JSON.stringify({ ...ledger, entries: ledger.entries.map((entry) => entry.name === CSV.name ? { ...entry, signatures: tablesSignatures } : entry) }))
            registry.goOffline()

            const sweep = await restartAndSweep()

            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-csv@0.6.0')?.outcome).toBe('refused: registry unreachable')
            expect(sweep.find(({ qadam }) => qadam === '@aiqadam/qadam-tables@0.5.1')?.outcome).toBe('verified')
        })
    })

    it('binds a stored version to the integrity of its own tarball, and gives an image seed or a custom qadam no npm signature', async () => {
        await warmTheVolume()
        const { store, ledger } = await reopen()
        const read = async (coordinates: QadamVersionCoordinates): Promise<Parameters<QadamSignatureLedger['checkStored']>[0]['version']> => {
            const result = await store.read({ coordinates })
            if (result.status !== QadamVersionReadStatus.PRESENT) {
                throw new Error(`${coordinates.name} is ${result.status}`)
            }
            return result.version
        }

        expect(await ledger.checkStored({ version: await read(CSV) })).toEqual({ verified: true })
        expect(await ledger.checkStored({ version: await read(SEEDED) })).toEqual({ verified: false, reason: QadamSignatureUnverified.NO_TARBALL_INTEGRITY })

        const custom = { platformId: 'AAAAAAAAAAAAAAAAAAAAA', name: 'acme-crm', version: '1.0.0' }
        const staging = await store.createStaging()
        await tarFixtures.writeFiles({ dir: staging, files: tarFixtures.bundleFiles({ name: custom.name, version: custom.version }) })
        await store.commit({ coordinates: custom, stagingDir: staging, origin: { kind: QadamVersionOrigin.ARCHIVE, tarballIntegrity: 'sha512-AAAA' } })
        expect(await ledger.checkStored({ version: await read(custom) })).toEqual({ verified: false, reason: QadamSignatureUnverified.NOT_OFFICIAL })
    })
})

// What the app's start-up sweep over the store is: read each version fully, and have each one that
// came from a registry vouched for by a persisted signature, asking the registry for the rest.
// `outcome` names what would happen to the version.
async function restartAndSweep(): Promise<SweepEntry[]> {
    const { store, ledger } = await reopen()
    const versions = await store.listVersions({ platformId: null })
    return Promise.all(versions.map(async (coordinates): Promise<SweepEntry> => {
        const qadam = `${coordinates.name}@${coordinates.version}`
        const read = await store.read({ coordinates, verify: true })
        if (read.status !== QadamVersionReadStatus.PRESENT) {
            return { qadam, outcome: read.status }
        }
        if (read.version.integrity.origin.kind === QadamVersionOrigin.IMAGE_SEED) {
            return { qadam, outcome: 'image-seed' }
        }
        const persisted = await ledger.checkStored({ version: read.version })
        if (persisted.verified) {
            return { qadam, outcome: 'verified' }
        }
        const integrity = read.version.integrity.origin.tarballIntegrity ?? ''
        const asked = await askRegistry({ coordinates, integrity })
        return { qadam, outcome: asked }
    }))
}

async function askRegistry({ coordinates, integrity }: { coordinates: QadamVersionCoordinates, integrity: string }): Promise<string> {
    const asked = await registry.signaturesFor({ name: coordinates.name, version: coordinates.version }).then((signatures) => ({ signatures }), () => null)
    if (asked === null) {
        return 'refused: registry unreachable'
    }
    const verifying = npmPackageSignature.verifying({ name: coordinates.name, version: coordinates.version, integrity, signatures: asked.signatures, trustedKeys: TRUSTED })
    return verifying.length > 0 ? 'verified' : 'refused: not signed by the registry'
}

// The first start, online: versions are fetched from the registry into the store and each is
// recorded with the signature the registry sent, as #806's fetch will do; the image seeds one.
async function warmTheVolume(): Promise<void> {
    for (const coordinates of [CSV, TABLES]) {
        expect(await storeFromRegistry({ coordinates, signed: true })).toBe(QadamVersionPutStatus.STORED)
    }
    const { store } = await reopen()
    const staging = await store.createStaging()
    await tarFixtures.writeFiles({ dir: staging, files: tarFixtures.bundleFiles({ name: SEEDED.name, version: SEEDED.version }) })
    const seeded = await store.commit({ coordinates: SEEDED, stagingDir: staging, origin: { kind: QadamVersionOrigin.IMAGE_SEED, tarballIntegrity: null } })
    expect(seeded.status).toBe(QadamVersionPutStatus.STORED)
}

async function storeFromRegistry({ coordinates, signed }: { coordinates: QadamVersionCoordinates, signed: boolean }): Promise<QadamVersionPutStatus> {
    const { store, ledger } = await reopen()
    const data = tarFixtures.tarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: coordinates.name, version: coordinates.version }) }) })
    const tarballPath = join(tempDir, `${coordinates.version}-${Math.random().toString(36).slice(2)}.tgz`)
    await writeFile(tarballPath, data)
    const integrity = tarFixtures.integrity({ data })
    registry.publish({ name: coordinates.name, version: coordinates.version, integrity })
    const put = await store.putTarball({ coordinates, tarballPath, expectedIntegrity: integrity, origin: { kind: QadamVersionOrigin.REGISTRY } })
    if (signed) {
        const signatures = await registry.signaturesFor({ name: coordinates.name, version: coordinates.version })
        const recorded = await ledger.record({ proofs: [{ name: coordinates.name, version: coordinates.version, integrity, signatures }] })
        expect(recorded).toEqual({ ok: true, recorded: 1, rejected: 0 })
    }
    return put.status
}

// The restart: nothing but the directory survives it.
async function reopen(): Promise<{ store: QadamVersionStore, ledger: QadamSignatureLedger }> {
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    return { store: opened.store, ledger: qadamSignatureLedger.open({ dir: opened.store.root, log, trustedKeys: TRUSTED }) }
}

async function readIntegrityFile({ coordinates }: { coordinates: QadamVersionCoordinates }): Promise<IntegrityFile> {
    return JSON.parse(await readFile(join(qadamVersionStoreLayout.versionDir({ root, coordinates }), 'integrity.json'), 'utf8'))
}

async function editIntegrityFile({ coordinates, change }: { coordinates: QadamVersionCoordinates, change: (record: IntegrityFile) => IntegrityFile }): Promise<void> {
    const file = join(qadamVersionStoreLayout.versionDir({ root, coordinates }), 'integrity.json')
    await writeFile(file, JSON.stringify(change(await readIntegrityFile({ coordinates }))))
}

// The registry npm would be: it signs `<name>@<version>:<integrity>` of what was published, and once
// offline every call fails and is counted (`calls` counts offline calls only).
function fakeRegistry(): FakeRegistry {
    const state = { online: true, calls: 0 }
    const published = new Map<string, string>()
    return {
        get calls(): number {
            return state.calls
        },
        goOffline: (): void => {
            state.online = false
        },
        publish: ({ name, version, integrity }): void => {
            published.set(`${name}@${version}`, integrity)
        },
        signaturesFor: async ({ name, version }): Promise<NpmPackageSignature[]> => {
            if (!state.online) {
                state.calls += 1
                throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
            }
            const integrity = published.get(`${name}@${version}`)
            if (integrity === undefined) {
                throw new Error('404')
            }
            return [{ keyid: KEY_ID, sig: sign('sha256', Buffer.from(`${name}@${version}:${integrity}`), privateKey).toString('base64') }]
        },
    }
}

type FakeRegistry = {
    readonly calls: number
    goOffline: () => void
    publish: (params: { name: string, version: string, integrity: string }) => void
    signaturesFor: (params: { name: string, version: string }) => Promise<NpmPackageSignature[]>
}

type SweepEntry = {
    qadam: string
    outcome: string
}

type IntegrityFile = {
    origin: { kind: string, tarballIntegrity: string | null }
} & Record<string, unknown>
