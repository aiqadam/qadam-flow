import { apId, isEmpty, isNil, PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import semVer from 'semver'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { QadamRegistryEntry } from '../qadam-cache'
import { QadamMetadataSchema } from '../qadam-metadata-entity'
import { fileQadamsUtils } from './file-qadams-utils'

export function isNewerVersion(a: string, b: string): boolean {
    const aValid = semVer.valid(a)
    const bValid = semVer.valid(b)
    if (!aValid && !bValid) {
        return a.localeCompare(b) > 0
    }
    if (!aValid) {
        return false
    }
    if (!bValid) {
        return true
    }
    return semVer.gt(a, b)
}

export function lastVersionOfEachQadam(qadams: QadamMetadataSchema[]): QadamMetadataSchema[] {
    const seen = new Map<string, QadamMetadataSchema>()
    for (const qadam of qadams) {
        const existing = seen.get(qadam.name)
        if (isNil(existing) || isNewerVersion(qadam.version, existing.version)) {
            seen.set(qadam.name, qadam)
        }
    }
    return Array.from(seen.values())
}

let bundledQadamsCachePromise: Promise<QadamMetadataSchema[]> | null = null

export function invalidateBundledQadamCache(): void {
    bundledQadamsCachePromise = null
}

export async function loadBundledQadams(log: FastifyBaseLogger): Promise<QadamMetadataSchema[]> {
    if (bundledQadamsCachePromise) {
        return bundledQadamsCachePromise
    }
    const devQadamsConfig = system.get(AppSystemProp.DEV_QADAMS)
    const filterNames = !isNil(devQadamsConfig) && !isEmpty(devQadamsConfig)
        ? devQadamsConfig.split(',').map((n) => n.trim()).filter((n) => !isEmpty(n))
        : null
    bundledQadamsCachePromise = loadFromDisk(log, filterNames)
    bundledQadamsCachePromise.catch(() => {
        bundledQadamsCachePromise = null
    })
    return bundledQadamsCachePromise
}

async function loadFromDisk(log: FastifyBaseLogger, filterNames: string[] | null): Promise<QadamMetadataSchema[]> {
    const pieces = filterNames !== null
        ? await fileQadamsUtils(log).loadDistQadamsMetadata(filterNames)
        : await fileQadamsUtils(log).loadAllDistQadamsMetadata()

    return pieces.map((p): QadamMetadataSchema => ({
        id: apId(),
        ...p,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
    }))
}

export function filterQadamBasedOnType(platformId: string | undefined, qadam: QadamMetadataSchema | QadamRegistryEntry): boolean {
    return isOfficialQadam(qadam) || isCustomQadam(platformId, qadam)
}

export function isOfficialQadam(qadam: QadamMetadataSchema | QadamRegistryEntry): boolean {
    return qadam.qadamType === QadamType.OFFICIAL && isNil(qadam.platformId)
}

export function isCustomQadam(platformId: string | undefined, qadam: QadamMetadataSchema | QadamRegistryEntry): boolean {
    if (isNil(platformId)) {
        return false
    }
    return qadam.platformId === platformId && qadam.qadamType === QadamType.CUSTOM
}

export function isSupportedRelease(release: string | undefined, qadam: { minimumSupportedRelease?: string, maximumSupportedRelease?: string }): boolean {
    if (isNil(release) || !semVer.valid(release)) {
        return true
    }
    if (!isNil(qadam.maximumSupportedRelease) && semVer.valid(qadam.maximumSupportedRelease) && semVer.compare(release, qadam.maximumSupportedRelease) === 1) {
        return false
    }
    if (!isNil(qadam.minimumSupportedRelease) && semVer.valid(qadam.minimumSupportedRelease) && semVer.compare(release, qadam.minimumSupportedRelease) === -1) {
        return false
    }
    return true
}
