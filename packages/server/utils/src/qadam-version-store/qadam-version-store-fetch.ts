import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { npmPackageSignature, NpmPackageSignature } from '../npm-package-signature'
import { safeHttp } from '../safe-http'
import { QadamSignatureLedger } from './qadam-signature-ledger'
import { QadamVersionOrigin, QadamVersionPutStatus, QadamVersionStore } from './qadam-version-store'
import { qadamVersionStoreFs } from './qadam-version-store-fs'
import { StoredQadamVersion } from './qadam-version-store-read'

// ADR-0003 "Fetching": a version missing from the store, fetched from npmjs into it. This is the one
// place that does it; the API decides WHICH pins to offer here (official scope, an exact release,
// not already available — `qadam-version-fetch.ts` in the `api` package) and this does the network
// and the store write for one.
//
// npmjs's signature is mandatory and not softened by `minimumReleaseAge` (ADR-0005): a version whose
// signature does not verify, or carries none, is refused before anything is extracted or stored —
// the same fail-closed rule `qadamIntegrity` (the legacy worker install path, #482) already applies,
// reused here rather than re-derived. What is NOT reused is that file's `bun.lock`-wide, lock-held,
// serial verification loop: a store fetch is one version at a time, outside any cross-replica lock
// (the store's own atomic rename is what makes two writers of the same version safe), so its own
// small per-version budget is enough.
//
// The default registry URL duplicates `OFFICIAL_QADAM_REGISTRY_URL` in
// `packages/server/worker/src/lib/cache/qadams/{qadam-integrity,qadam-installer}.ts`; this is a
// third copy for the same reason those two could not import each other (worker vs. a store fetch
// that belongs in `server-utils`, so the engine's reader stays free of network code). #478's
// configurable registry (`QADAM_REGISTRY_URL` / `QADAM_REGISTRY_TOKEN`) is for custom qadams only:
// an official pin always comes from npmjs with the signature checked below, whatever a platform
// configures, so that setting must not reach this constant.
export const DEFAULT_QADAM_REGISTRY_URL = 'https://registry.npmjs.org'

export enum QadamVersionFetchOutcome {
    FETCHED = 'fetched',
    // The registry has no such version of this name: a 404 on the version document.
    NOT_PUBLISHED = 'not-published',
    // The version document could not be read at all (network, timeout, 5xx after retry, rate limit
    // exhausted) — an availability failure, not a security one.
    NETWORK_ERROR = 'network-error',
    // The version document did not carry a `dist.integrity`/`dist.tarball` this can use.
    MALFORMED_METADATA = 'malformed-metadata',
    // No signature from a key this image pins verifies the name, version and integrity together.
    UNSIGNED = 'unsigned',
    // The tarball could not be downloaded, or its bytes did not match the signed integrity.
    DOWNLOAD_FAILED = 'download-failed',
    // The store itself refused it (a damaged/unsupported version already occupies the slot, or the
    // integrity format is one the store cannot use).
    STORE_REFUSED = 'store-refused',
}

export type QadamVersionFetchResult =
    | { outcome: QadamVersionFetchOutcome.FETCHED, version: StoredQadamVersion }
    | { outcome: Exclude<QadamVersionFetchOutcome, QadamVersionFetchOutcome.FETCHED>, reason: string }

export const qadamVersionStoreFetch = {
    // Fetches exactly `name@version` from the registry into `store`, verifying npmjs's signature
    // first and refusing to store anything it did not sign. Never throws: every failure is a typed
    // outcome, because a fetch that cannot complete is not this release's problem to crash over —
    // the existing unavailable-version fallback (#808) is what a caller falls through to.
    fetchFromRegistry: async ({ store, ledger, name, version, log, registryUrl = DEFAULT_QADAM_REGISTRY_URL, deadline = Date.now() + DEFAULT_FETCH_BUDGET_MS }: FetchFromRegistryParams): Promise<QadamVersionFetchResult> => {
        const metadata = await readVersionDocument({ name, version, registryUrl, deadline, log })
        if (!metadata.ok) {
            return { outcome: metadata.outcome, reason: metadata.reason }
        }
        const dist = readDist({ versionDocument: metadata.data })
        if (isNil(dist)) {
            return { outcome: QadamVersionFetchOutcome.MALFORMED_METADATA, reason: 'the version document carries no usable dist.integrity/dist.tarball' }
        }
        // The signature binds `<name>@<version>:<dist.integrity>`, not `dist.tarball` — a rewriting
        // proxy or a poisoned mirror could replay a genuine signature while pointing the tarball at
        // its own host. The integrity check after download still refuses mismatched bytes, but this
        // keeps the download itself from ever leaving the registry it was asked to fetch from.
        if (!isTrustedTarballUrl({ tarball: dist.tarball, registryUrl })) {
            return { outcome: QadamVersionFetchOutcome.MALFORMED_METADATA, reason: 'dist.tarball is not an https URL on the configured registry\'s own origin' }
        }
        // Always the pinned-key production verifier singleton — never a parameter this function
        // takes (see `npm-package-signature.ts`'s header on why pinning is the whole point). This
        // package's own tests mock the module instead of being handed a seam a production caller
        // could just as easily misuse.
        // `verifying` applies `pinned` itself, so `signatures` is handed to it directly rather than
        // pre-filtered here — filtering twice would cost nothing but a reader has no way to tell that
        // apart from a second, narrower filter that actually does something.
        const signatures = npmPackageSignature.readSignatures({ versionDocument: metadata.data })
        const verifying = npmPackageSignature.verifying({ name, version, integrity: dist.integrity, signatures })
        if (verifying.length === 0) {
            return { outcome: QadamVersionFetchOutcome.UNSIGNED, reason: signatures.length === 0 ? 'the registry returned no publisher signature for it' : 'no signature from a key this image pins verifies the name, version and integrity together' }
        }
        const downloaded = await downloadTarball({ store, url: dist.tarball, deadline, log, qadam: `${name}@${version}` })
        if (!downloaded.ok) {
            return { outcome: QadamVersionFetchOutcome.DOWNLOAD_FAILED, reason: downloaded.reason }
        }
        try {
            // `putTarball` throws on a handful of store-internal failures (a damaged slot that
            // will not yield after its retries, a rename across a cross-device boundary) rather
            // than returning `REFUSED` for them — exactly the kind of failure this function's own
            // "never throws" contract exists to absorb, so it is not left to escape uncaught.
            const put = await tryCatch(() => store.putTarball({
                coordinates: { platformId: null, name, version },
                tarballPath: downloaded.tarballPath,
                expectedIntegrity: dist.integrity,
                origin: { kind: QadamVersionOrigin.REGISTRY },
            }))
            if (put.error !== null) {
                return { outcome: QadamVersionFetchOutcome.STORE_REFUSED, reason: `the store could not take the downloaded tarball (${describeError({ error: put.error })})` }
            }
            if (put.data.status === QadamVersionPutStatus.REFUSED) {
                return { outcome: QadamVersionFetchOutcome.STORE_REFUSED, reason: put.data.reason }
            }
            await persistProof({ ledger, name, version, integrity: dist.integrity, signatures: verifying, log })
            return { outcome: QadamVersionFetchOutcome.FETCHED, version: put.data.version }
        }
        finally {
            // Never let a cleanup failure replace the result the `try` block just computed — JS
            // `finally` semantics mean a throw here would silently discard it.
            await discardStagingQuietly({ store, stagingDir: downloaded.stagingDir, qadam: `${name}@${version}`, log })
        }
    },
}

// Wraps `store.discardStaging`, which can throw (a staging directory outside the store's own root,
// a filesystem error), so cleanup never becomes the failure a caller sees instead of the real one.
async function discardStagingQuietly({ store, stagingDir, qadam, log }: { store: QadamVersionStore, stagingDir: string, qadam: string, log: FetchLogger }): Promise<void> {
    const discarded = await tryCatch(() => store.discardStaging({ stagingDir }))
    if (discarded.error !== null) {
        log.warn({ qadam, error: describeError({ error: discarded.error }) }, '[qadamVersionStoreFetch] could not discard the fetch\'s staging directory; it is left for the store\'s own stale-leftover sweep')
    }
}

// One registry read and one tarball download, each with their own retry; a per-version pass is not
// shared with any lock, so there is no cross-process budget to protect the way `qadamIntegrity`'s is.
const DEFAULT_FETCH_BUDGET_MS = 20_000
const REGISTRY_TIMEOUT_MS = 10_000
const REGISTRY_RATE_LIMIT_ATTEMPTS = 3
const REGISTRY_RATE_LIMIT_BACKOFF_MS = 1_000
const HTTP_NOT_FOUND = 404
const HTTP_TOO_MANY_REQUESTS = 429
// A qadam's own code plus its third-party dependencies, not the platform libraries it never bundles
// (ADR-0003: the median is 73 KB, the largest measured bundle 462 KB raw; `bundle-with-node-modules`
// closures run larger). This is a sanity cap on what a fetch downloads into memory before the
// store's own `qadamVersionStoreTarball.extract` applies its own, larger, byte-accurate limit.
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

async function readVersionDocument({ name, version, registryUrl, deadline, log }: ReadVersionDocumentParams): Promise<VersionDocumentResult> {
    const url = `${registryUrl}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
    let attempt = 1
    for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            return { ok: false, outcome: QadamVersionFetchOutcome.NETWORK_ERROR, reason: 'the registry did not answer within this fetch\'s time budget' }
        }
        const { data: response, error } = await tryCatch(async () => safeHttp.retryingAxios.get<unknown>(url, { timeout: Math.min(REGISTRY_TIMEOUT_MS, remaining) }))
        if (!isNil(response) && isNil(error)) {
            return { ok: true, data: response.data }
        }
        if (isNotFound({ error })) {
            return { ok: false, outcome: QadamVersionFetchOutcome.NOT_PUBLISHED, reason: 'the registry has no such version' }
        }
        if (attempt >= REGISTRY_RATE_LIMIT_ATTEMPTS || !isRateLimited({ error })) {
            log.warn({ name, version, error: describeError({ error }) }, '[qadamVersionStoreFetch] could not read the registry\'s version document')
            return { ok: false, outcome: QadamVersionFetchOutcome.NETWORK_ERROR, reason: 'could not read the registry\'s version document' }
        }
        await delay(Math.min(REGISTRY_RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1), Math.max(0, deadline - Date.now())))
        attempt += 1
    }
}

// Downloaded into the store's own staging area (the same filesystem `putTarball`'s own extraction
// renames out of), not a bare OS temp directory: a cross-device rename inside `putTarball` would
// otherwise turn its atomic `rename` into a copy. The caller discards this directory once
// `putTarball` has read the file out of it.
async function downloadTarball({ store, url, deadline, log, qadam }: DownloadTarballParams): Promise<DownloadResult> {
    const staging = await tryCatch(() => store.createStaging())
    if (staging.error !== null) {
        log.warn({ qadam, error: describeError({ error: staging.error }) }, '[qadamVersionStoreFetch] could not create a staging directory for the download')
        return { ok: false, reason: 'could not create a staging directory for the download' }
    }
    const stagingDir = staging.data
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        await discardStagingQuietly({ store, stagingDir, qadam, log })
        return { ok: false, reason: 'no time budget left to download the tarball' }
    }
    const { data: response, error } = await tryCatch(async () => safeHttp.retryingAxios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: Math.min(REGISTRY_TIMEOUT_MS * 2, remaining),
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
    }))
    if (isNil(response) || !isNil(error)) {
        log.warn({ qadam, url, error: describeError({ error }) }, '[qadamVersionStoreFetch] could not download the tarball')
        await discardStagingQuietly({ store, stagingDir, qadam, log })
        return { ok: false, reason: 'could not download the tarball' }
    }
    const tarballPath = path.join(stagingDir, `${randomUUID()}.tgz`)
    const written = await tryCatch(() => writeFile(tarballPath, Buffer.from(response.data)))
    if (written.error !== null) {
        await discardStagingQuietly({ store, stagingDir, qadam, log })
        return { ok: false, reason: `the downloaded tarball could not be written to disk (${qadamVersionStoreFs.describeErrorCode({ error: written.error })})` }
    }
    return { ok: true, tarballPath, stagingDir }
}

// `https:` and the registry's own origin only — same-origin because `safeHttp` already keeps the
// request off a private/loopback/metadata address regardless of host, so this is about not trusting
// a tarball URL the signed version document did not actually need to name a different host.
function isTrustedTarballUrl({ tarball, registryUrl }: { tarball: string, registryUrl: string }): boolean {
    const parsedTarball = tryCatchSync(() => new URL(tarball))
    const parsedRegistry = tryCatchSync(() => new URL(registryUrl))
    if (parsedTarball.error !== null || parsedRegistry.error !== null) {
        return false
    }
    return parsedTarball.data.protocol === 'https:' && parsedTarball.data.origin === parsedRegistry.data.origin
}

async function persistProof({ ledger, name, version, integrity, signatures, log }: PersistProofParams): Promise<void> {
    const recorded = await ledger.record({ proofs: [{ name, version, integrity, signatures }] })
    if (!recorded.ok) {
        log.warn({ name, version, reason: recorded.reason }, '[qadamVersionStoreFetch] could not persist the verified signature; the next restart verifies it against the registry again')
    }
}

// `dist` is external data of unknown shape, walked key by key rather than cast.
function readDist({ versionDocument }: { versionDocument: unknown }): { integrity: string, tarball: string } | null {
    const dist = readProperty({ source: versionDocument, key: 'dist' })
    const integrity = readProperty({ source: dist, key: 'integrity' })
    const tarball = readProperty({ source: dist, key: 'tarball' })
    return typeof integrity === 'string' && typeof tarball === 'string' ? { integrity, tarball } : null
}

function readProperty({ source, key }: { source: unknown, key: string }): unknown {
    return isRecord(source) ? source[key] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound({ error }: { error: unknown }): boolean {
    return readProperty({ source: readProperty({ source: error, key: 'response' }), key: 'status' }) === HTTP_NOT_FOUND
}

function isRateLimited({ error }: { error: unknown }): boolean {
    return readProperty({ source: readProperty({ source: error, key: 'response' }), key: 'status' }) === HTTP_TOO_MANY_REQUESTS
}

function describeError({ error }: { error: unknown }): string {
    return error instanceof Error ? error.message : 'unknown error'
}

type FetchLogger = {
    warn: (obj: Record<string, unknown>, msg: string) => void
}

type FetchFromRegistryParams = {
    store: QadamVersionStore
    ledger: QadamSignatureLedger
    name: string
    version: string
    log: FetchLogger
    registryUrl?: string
    // Wall-clock deadline for the whole fetch (one registry read and one download, each with their
    // own retries); defaults to `DEFAULT_FETCH_BUDGET_MS` from now.
    deadline?: number
}

type ReadVersionDocumentParams = {
    name: string
    version: string
    registryUrl: string
    deadline: number
    log: FetchLogger
}

type VersionDocumentResult =
    | { ok: true, data: unknown }
    | { ok: false, outcome: Exclude<QadamVersionFetchOutcome, QadamVersionFetchOutcome.FETCHED>, reason: string }

type DownloadTarballParams = {
    store: QadamVersionStore
    url: string
    deadline: number
    log: FetchLogger
    qadam: string
}

type DownloadResult =
    | { ok: true, tarballPath: string, stagingDir: string }
    | { ok: false, reason: string }

type PersistProofParams = {
    ledger: QadamSignatureLedger
    name: string
    version: string
    integrity: string
    signatures: NpmPackageSignature[]
    log: FetchLogger
}
