import { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { QadamMetadata, QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    QADAM_VERSION_STORE_LAYOUT,
    QadamVersionIntegrity,
    qadamVersionStoreLayout,
    qadamVersionStoreReader,
    StoredQadamVersion,
} from '@aiqadam/server-utils'
import {
    apId,
    isNil,
    isOfficialQadamName,
    PackageType,
    QadamType,
    tryCatch,
    tryCatchSync,
} from '@aiqadam/shared'
import semVer from 'semver'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES, qadamVersionCatalogueFormat } from '../../catalogue/qadam-version-catalogue-format'
import { qadamVersionCatalogueSource } from '../../catalogue/qadam-version-catalogue-source'

// The API's read side of the qadam version store (#779): the metadata of a version the store holds,
// so a pin is answered the same way whether it lives in the image, `qadam_metadata` or the store. It
// is read-only and bounded by the same reader the engine uses. A version that is not PRESENT
// (damaged, unsupported here, unreadable) is `absent`, exactly as the engine skips it; a PRESENT one
// whose `metadata.json` cannot be read is `unusable`, which a caller must fail rather than replace.
export const storedQadamMetadata = {
    // What the store holds at these coordinates. `unusable` is a version the store calls PRESENT but
    // whose `metadata.json` cannot be read as this qadam's metadata; a caller must fail the pin rather
    // than substitute another build, because the engine would still run the stored code (#779).
    lookup: async ({ name, version }: { name: string, version: string }): Promise<StoredQadamLookup> => {
        if (!isOfficialQadamName(name)) {
            return { status: 'absent' }
        }
        const reader = await openReader()
        if (isNil(reader)) {
            return { status: 'absent' }
        }
        const key = `${reader.root}\0${name}@${version}`
        const cached = metadataByVersion.get(key)
        if (!isNil(cached) && cached.expiresAt > Date.now()) {
            return { status: 'present', stored: cached.stored }
        }
        const located = await locateStoredVersion({ reader, name, version })
        if (isNil(located)) {
            return { status: 'absent' }
        }
        const metadata = await readMetadataFile({ directory: located.dir, name, version })
        if (isNil(metadata)) {
            return { status: 'unusable' }
        }
        const stored: StoredQadamMetadata = {
            metadata: toMetadataModel({ metadata }),
            frameworkMajor: frameworkMajorOf({ builtAgainst: located.integrity.builtAgainst }),
        }
        rememberMetadata({ key, stored })
        return { status: 'present', stored }
    },

    // For callers that only need a usable version's metadata: `undefined` for both absent and unusable.
    read: async ({ name, version }: { name: string, version: string }): Promise<StoredQadamMetadata | undefined> => {
        const found = await storedQadamMetadata.lookup({ name, version })
        return found.status === 'present' ? found.stored : undefined
    },

    // Every official version the store holds, for the registry the builder and the heal path read.
    // Each version is read through the store reader, so a damaged or unusable one is left out rather
    // than offered. The result is cached with its in-flight promise for a few seconds: a fetch (#806)
    // can add a version while the process lives, and this endpoint is public, so concurrent requests
    // share one walk rather than each starting their own.
    list: async (): Promise<StoredQadamSummary[]> => {
        const reader = await openReader()
        if (isNil(reader)) {
            return []
        }
        const cached = listByRoot.get(reader.root)
        if (!isNil(cached) && cached.expiresAt > Date.now()) {
            return cached.value
        }
        const value = scanStore({ reader }).catch((error: unknown) => {
            listByRoot.delete(reader.root)
            throw error
        })
        listByRoot.set(reader.root, { expiresAt: Date.now() + LIST_TTL_MS, value })
        return value
    },

    // Tests replace the store between cases; the reader is otherwise opened once per process.
    reset: (): void => {
        opened = null
        metadataByVersion.clear()
        listByRoot.clear()
    },
}

// A short window keeps a version fetched mid-life visible without walking every version's metadata
// on every public `GET /v1/qadams/registry`.
const LIST_TTL_MS = 5_000
// The same for a pin's metadata: a version is immutable, but a store GC (#478) can remove one and a
// fetch (#806) can repair a damaged one, so a cached answer is not kept for the life of the process.
const METADATA_TTL_MS = 30_000
// Pins resolved from a large flow must not pin every version's actions, triggers and i18n in memory
// for good; the cache is a hot-path aid, not a catalogue. The oldest entry is dropped first.
const MAX_METADATA_CACHE_ENTRIES = 1_000

const metadataByVersion = new Map<string, { expiresAt: number, stored: StoredQadamMetadata }>()

const listByRoot = new Map<string, { expiresAt: number, value: Promise<StoredQadamSummary[]> }>()

function rememberMetadata({ key, stored }: { key: string, stored: StoredQadamMetadata }): void {
    if (metadataByVersion.size >= MAX_METADATA_CACHE_ENTRIES) {
        const oldest = metadataByVersion.keys().next().value
        if (!isNil(oldest)) {
            metadataByVersion.delete(oldest)
        }
    }
    metadataByVersion.set(key, { expiresAt: Date.now() + METADATA_TTL_MS, stored })
}

async function scanStore({ reader }: { reader: StoreReader }): Promise<StoredQadamSummary[]> {
    const qadamsDir = path.join(reader.root, QADAM_VERSION_STORE_LAYOUT.qadamsDir)
    const names = await listOfficialNames({ qadamsDir })
    const versions: StoredQadamSummary[] = []
    for (const name of names) {
        for (const version of await listVersionNames({ qadamsDir, name })) {
            const located = await locateStoredVersion({ reader, name, version })
            if (isNil(located)) {
                continue
            }
            const metadata = await readMetadataFile({ directory: located.dir, name, version })
            if (isNil(metadata)) {
                continue
            }
            versions.push({
                name,
                version,
                minimumSupportedRelease: metadata.minimumSupportedRelease,
                maximumSupportedRelease: metadata.maximumSupportedRelease,
            })
        }
    }
    return versions
}

async function locateStoredVersion({ reader, name, version }: { reader: StoreReader, name: string, version: string }): Promise<StoredQadamVersion | undefined> {
    // A platform's custom qadams live in their own namespace and are not resolved here yet.
    if (!isOfficialQadamName(name)) {
        return undefined
    }
    const { data: stored } = await tryCatch(() => reader.read({ coordinates: { platformId: null, name, version } }))
    return stored?.status === 'present' ? stored.version : undefined
}

// One open per process and store root: `open` resolves the real path and walks up from it, which is
// not worth repeating for every pin. A failed open is not cached, so a store that appears later (a
// dev tree, or the app before its first seed) is picked up.
let opened: { root: string, opening: Promise<StoreReader | null> } | null = null

async function openReader(): Promise<StoreReader | null> {
    const root = system.getOrThrow(AppSystemProp.QADAM_VERSION_STORE_PATH)
    if (opened?.root === root) {
        const reader = await opened.opening
        if (!isNil(reader)) {
            return reader
        }
        opened = null
    }
    const opening = (async (): Promise<StoreReader | null> => {
        const { data, error } = await tryCatch(() => qadamVersionStoreReader.open({ root }))
        return error === null && data.ok ? data.reader : null
    })()
    opened = { root, opening }
    const reader = await opening
    if (isNil(reader)) {
        opened = null
    }
    return reader
}

async function readMetadataFile({ directory, name, version }: { directory: string, name: string, version: string }): Promise<QadamMetadata | undefined> {
    const file = await qadamVersionCatalogueSource.directory({ root: directory }).read({
        relativePath: QADAM_VERSION_STORE_LAYOUT.metadataFile,
        maxBytes: QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES,
    })
    if (file.status !== 'ok') {
        return undefined
    }
    const checked = qadamVersionCatalogueFormat.checkMetadataFile({ bytes: file.bytes, name, version })
    return checked.status === 'ok' ? checked.metadata : undefined
}

function toMetadataModel({ metadata }: { metadata: QadamMetadata }): QadamMetadataModel {
    return {
        ...metadata,
        id: apId(),
        // A metadata file is untrusted input as far as its package fields go: never let it claim a
        // platform, which would make an official row read as another tenant's custom qadam.
        platformId: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    }
}

// The exact framework build an artifact was built against (`integrity.json`'s `builtAgainst`, ADR-0004
// decision 8), or its lowest version when an older artifact recorded a range. Unknown is `null`.
function frameworkMajorOf({ builtAgainst }: { builtAgainst: QadamVersionIntegrity['builtAgainst'] }): number | null {
    const framework = builtAgainst?.framework
    if (isNil(framework)) {
        return null
    }
    const { data: minimum } = tryCatchSync(() => semVer.minVersion(framework))
    return minimum?.major ?? null
}

async function listOfficialNames({ qadamsDir }: { qadamsDir: string }): Promise<string[]> {
    const entries = await readDirectory({ directory: qadamsDir })
    const names: string[] = []
    for (const entry of entries) {
        if (!entry.isDirectory() || qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName: entry.name })) {
            continue
        }
        if (!entry.name.startsWith('@')) {
            names.push(entry.name)
            continue
        }
        const scoped = await readDirectory({ directory: path.join(qadamsDir, entry.name) })
        for (const child of scoped) {
            if (child.isDirectory() && !qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName: child.name })) {
                names.push(`${entry.name}/${child.name}`)
            }
        }
    }
    return names.sort((a, b) => a.localeCompare(b))
}

async function listVersionNames({ qadamsDir, name }: { qadamsDir: string, name: string }): Promise<string[]> {
    const entries = await readDirectory({ directory: path.join(qadamsDir, ...name.split('/')) })
    return entries
        .filter((entry) => entry.isDirectory() && !qadamVersionStoreLayout.isReservedNamespaceEntry({ entryName: entry.name }))
        .map((entry) => entry.name)
        .sort((a, b) => tryCatchSync(() => semVer.compare(a, b)).data ?? a.localeCompare(b))
}

async function readDirectory({ directory }: { directory: string }): Promise<Dirent[]> {
    const { data } = await tryCatch(() => readdir(directory, { withFileTypes: true }))
    return data ?? []
}

type StoreReader = Extract<Awaited<ReturnType<typeof qadamVersionStoreReader.open>>, { ok: true }>['reader']

export type StoredQadamLookup =
    | { status: 'absent' }
    | { status: 'unusable' }
    | { status: 'present', stored: StoredQadamMetadata }

export type StoredQadamMetadata = {
    metadata: QadamMetadataModel
    // Known from the artifact's own record; `null` when it does not say (a legacy npm version).
    frameworkMajor: number | null
}

export type StoredQadamSummary = {
    name: string
    version: string
    minimumSupportedRelease?: string
    maximumSupportedRelease?: string
}
