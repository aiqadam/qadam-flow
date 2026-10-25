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
// is read-only and bounded by the same reader the engine uses; a version that is not PRESENT (damaged,
// unsupported here, unreadable) answers `undefined`, exactly as the engine skips it.
export const storedQadamMetadata = {
    // Whether the store holds a usable version at these coordinates, without reading its metadata.
    // A caller that only needs "does the pin resolve" (the census, a batch resolution) stops here.
    holds: async ({ name, version }: { name: string, version: string }): Promise<boolean> => {
        if (!isOfficialQadamName(name)) {
            return false
        }
        const reader = await openReader()
        if (isNil(reader)) {
            return false
        }
        const { data: stored } = await tryCatch(() => reader.read({ coordinates: { platformId: null, name, version } }))
        return stored?.status === 'present'
    },

    // `undefined` is "the store does not hold a usable version at these coordinates" — including an
    // unreadable store, which must never make the registry answer disappear.
    read: async ({ name, version }: { name: string, version: string }): Promise<StoredQadamMetadata | undefined> => {
        const stored = await locateStoredVersion({ name, version })
        if (isNil(stored)) {
            return undefined
        }
        const metadata = await readMetadataFile({ directory: stored.dir, name, version })
        if (isNil(metadata)) {
            return undefined
        }
        return {
            metadata: toMetadataModel({ metadata }),
            frameworkMajor: frameworkMajorOf({ builtAgainst: stored.integrity.builtAgainst }),
        }
    },

    // Every official version the store holds, for the registry the builder and the heal path read.
    // Each version is read through `read`, so a damaged one is left out rather than offered.
    list: async (): Promise<StoredQadamSummary[]> => {
        const reader = await openReader()
        if (isNil(reader)) {
            return []
        }
        const qadamsDir = path.join(reader.root, QADAM_VERSION_STORE_LAYOUT.qadamsDir)
        const names = await listOfficialNames({ qadamsDir })
        const versions: StoredQadamSummary[] = []
        for (const name of names) {
            for (const version of await listVersionNames({ qadamsDir, name })) {
                const stored = await storedQadamMetadata.read({ name, version })
                if (isNil(stored)) {
                    continue
                }
                versions.push({
                    name,
                    version,
                    minimumSupportedRelease: stored.metadata.minimumSupportedRelease,
                    maximumSupportedRelease: stored.metadata.maximumSupportedRelease,
                })
            }
        }
        return versions
    },

    // Tests replace the store between cases; the reader is otherwise opened once per process.
    reset: (): void => {
        opened = null
    },
}

async function locateStoredVersion({ name, version }: { name: string, version: string }): Promise<StoredQadamVersion | undefined> {
    // A platform's custom qadams live in their own namespace and are not resolved here yet.
    if (!isOfficialQadamName(name)) {
        return undefined
    }
    const reader = await openReader()
    if (isNil(reader)) {
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
