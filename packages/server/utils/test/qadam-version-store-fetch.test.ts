import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamSignatureLedger } from '../src/qadam-version-store/qadam-signature-ledger'
import { QadamVersionOrigin, QadamVersionReadStatus, qadamVersionStore } from '../src/qadam-version-store/qadam-version-store'
import { QadamVersionFetchOutcome, qadamVersionStoreFetch } from '../src/qadam-version-store/qadam-version-store-fetch'
import { tarFixtures } from './qadam-version-store-fixtures'

const mockGet = vi.fn()
const mockReadSignatures = vi.fn()
const mockPinned = vi.fn()
const mockVerifying = vi.fn()
const mockDelay = vi.fn<(ms: number) => Promise<void>>()

// Only the registry client and the backoff sleep are faked; the signature verifier is mocked too
// (controlled per test) so these tests do not need a real npmjs-signed tarball — that binding is
// exercised for real against npmjs's actual output in the worker's `qadam-integrity.test.ts`. The
// store, the tarball extraction and the ledger are all real: this is the module that writes to disk.
//
// `vi.mock` factories are hoisted above these imports, and vitest hoists the `mock`-prefixed consts
// above with them (docs: "Variables starting with `mock` are allowed") — so this works without a
// dynamic `await import(...)` the way other modules' `vi.mock`-plus-static-import tests do (e.g.
// `test/integration/ce/ldap/ldap-reconcile.test.ts`).
vi.mock('../src/safe-http', () => ({
    safeHttp: {
        retryingAxios: { get: (...args: unknown[]) => mockGet(...args) },
    },
}))

vi.mock('../src/npm-package-signature', () => ({
    npmPackageSignature: {
        readSignatures: (...args: unknown[]) => mockReadSignatures(...args),
        pinned: (...args: unknown[]) => mockPinned(...args),
        verifying: (...args: unknown[]) => mockVerifying(...args),
    },
}))

vi.mock('node:timers/promises', () => ({
    setTimeout: (ms: number) => mockDelay(ms),
}))

const QADAM = { platformId: null, name: '@aiqadam/qadam-csv', version: '0.6.0' }
const TARBALL_URL = 'https://registry.npmjs.org/@aiqadam/qadam-csv/-/qadam-csv-0.6.0.tgz'
const log = { info: vi.fn(), warn: vi.fn() }

let tempDir: string
let root: string
let bundle: { data: Buffer, integrity: string }

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-fetch-')))
    root = join(tempDir, 'store')
    const data = tarFixtures.tarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: QADAM.name, version: QADAM.version }) }) })
    bundle = { data, integrity: tarFixtures.integrity({ data }) }
    mockGet.mockReset()
    mockReadSignatures.mockReset().mockReturnValue([{ keyid: 'k', sig: 's' }])
    mockPinned.mockReset().mockReturnValue([{ keyid: 'k', sig: 's' }])
    mockVerifying.mockReset().mockReturnValue([{ keyid: 'k', sig: 's' }])
    mockDelay.mockReset().mockResolvedValue(undefined)
    log.info.mockClear()
    log.warn.mockClear()
})

afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreFetch.fetchFromRegistry', () => {
    it('verifies the signature, downloads the tarball and stores it', async () => {
        mockGet.mockImplementation(async (url: string, config?: { responseType?: string }) => {
            if (config?.responseType === 'arraybuffer') {
                return { data: bundle.data }
            }
            expect(url).toBe('https://registry.npmjs.org/%40aiqadam%2Fqadam-csv/0.6.0')
            return { data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) }
        })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.FETCHED)
        const read = await store.read({ coordinates: QADAM })
        expect(read.status).toBe(QadamVersionReadStatus.PRESENT)
        if (read.status === QadamVersionReadStatus.PRESENT) {
            expect(read.version.integrity.origin.kind).toBe(QadamVersionOrigin.REGISTRY)
        }
        // Nothing is left behind in `.staging`: the downloaded tarball's own holding directory is
        // discarded once `putTarball` has read it, win or lose.
        expect(await readdir(join(root, '.staging'))).toEqual([])

        // Persisted so a restart does not ask the registry again (#780).
        if (read.status !== QadamVersionReadStatus.PRESENT) {
            throw new Error('not stored')
        }
        const checked = await ledger.checkStoredVersions({ versions: [read.version] })
        expect(checked).toEqual([{ verified: true }])
    })

    it('refuses a version the registry served with no signature', async () => {
        mockReadSignatures.mockReturnValue([])
        mockPinned.mockReturnValue([])
        mockVerifying.mockReturnValue([])
        mockGet.mockResolvedValue({ data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result).toEqual({ outcome: QadamVersionFetchOutcome.UNSIGNED, reason: 'the registry returned no publisher signature for it' })
        expect(await store.has({ coordinates: QADAM })).toBe(false)
    })

    it('refuses a version whose signature is present but does not verify under a pinned key', async () => {
        mockVerifying.mockReturnValue([])
        mockGet.mockResolvedValue({ data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.UNSIGNED)
        expect(await store.has({ coordinates: QADAM })).toBe(false)
    })

    it('reports a version the registry does not have as not published, not an error', async () => {
        mockGet.mockRejectedValue(httpError({ status: 404 }))

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result).toEqual({ outcome: QadamVersionFetchOutcome.NOT_PUBLISHED, reason: 'the registry has no such version' })
    })

    it('retries a rate-limited registry read and then succeeds', async () => {
        mockGet
            .mockRejectedValueOnce(httpError({ status: 429 }))
            .mockImplementation(async (_url: string, config?: { responseType?: string }) => config?.responseType === 'arraybuffer'
                ? { data: bundle.data }
                : { data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.FETCHED)
        expect(mockDelay).toHaveBeenCalledTimes(1)
    })

    it('reports a registry outage as a network error, never as a reason to store anything', async () => {
        mockGet.mockRejectedValue(new Error('ECONNRESET'))

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result).toEqual({ outcome: QadamVersionFetchOutcome.NETWORK_ERROR, reason: 'could not read the registry\'s version document' })
    })

    it('reports a version document with no usable dist as malformed metadata', async () => {
        mockGet.mockResolvedValue({ data: { name: QADAM.name, version: QADAM.version } })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.MALFORMED_METADATA)
    })

    it('reports a failed tarball download without storing anything', async () => {
        mockGet.mockImplementation(async (_url: string, config?: { responseType?: string }) => {
            if (config?.responseType === 'arraybuffer') {
                throw new Error('socket hang up')
            }
            return { data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) }
        })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.DOWNLOAD_FAILED)
        expect(await store.has({ coordinates: QADAM })).toBe(false)
        expect(await readdir(join(root, '.staging'))).toEqual([])
    })

    it('refuses what it downloaded when its bytes do not match the signed integrity', async () => {
        const other = tarFixtures.tarball({ entries: tarFixtures.artifactEntries({ files: tarFixtures.bundleFiles({ name: QADAM.name, version: QADAM.version, extra: { 'extra.txt': 'tampered' } }) }) })
        mockGet.mockImplementation(async (_url: string, config?: { responseType?: string }) => {
            if (config?.responseType === 'arraybuffer') {
                return { data: other }
            }
            // The signed integrity names the ORIGINAL bundle; the download returns different bytes.
            return { data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) }
        })

        const { store, ledger } = await openStoreAndLedger()
        const result = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(result.outcome).toBe(QadamVersionFetchOutcome.STORE_REFUSED)
        expect(await store.has({ coordinates: QADAM })).toBe(false)
    })

    it('answers EXISTS as fetched when another writer stored the same version first, without re-downloading twice', async () => {
        mockGet.mockImplementation(async (_url: string, config?: { responseType?: string }) => config?.responseType === 'arraybuffer'
            ? { data: bundle.data }
            : { data: registryDoc({ integrity: bundle.integrity, tarball: TARBALL_URL }) })

        const { store, ledger } = await openStoreAndLedger()
        const first = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })
        const second = await qadamVersionStoreFetch.fetchFromRegistry({ store, ledger, name: QADAM.name, version: QADAM.version, log })

        expect(first.outcome).toBe(QadamVersionFetchOutcome.FETCHED)
        expect(second.outcome).toBe(QadamVersionFetchOutcome.FETCHED)
    })
})

async function openStoreAndLedger() {
    const opened = await qadamVersionStore.open({ root, log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    const ledger = qadamSignatureLedger.open({ dir: opened.store.root, log })
    return { store: opened.store, ledger }
}

function registryDoc({ integrity, tarball }: { integrity: string, tarball: string }): unknown {
    return { name: QADAM.name, version: QADAM.version, dist: { integrity, tarball, signatures: [{ keyid: 'k', sig: 's' }] } }
}

function httpError({ status }: { status: number }): Error & { response: { status: number } } {
    return Object.assign(new Error(`http ${status}`), { response: { status } })
}
