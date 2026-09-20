import { ApEnvironment, isNil, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { pubsub } from '../../helper/pubsub'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { QadamMetadataEntity, QadamMetadataSchema } from './qadam-metadata-entity'
import { loadBundledQadams } from './utils'

const repo = repoFactory(QadamMetadataEntity)
const environment = system.get<ApEnvironment>(AppSystemProp.ENVIRONMENT)
const isTestingEnvironment = environment === ApEnvironment.TESTING

let cachedRegistry: QadamRegistryEntry[] | null = null
let registryGeneration = 0

export const qadamCache = (log: FastifyBaseLogger) => {
    return {
        async setup(): Promise<void> {
            log.info('[qadamCache] Registry cache initialized')
            if (!isTestingEnvironment) {
                await pubsub.subscribe(QADAM_REGISTRY_INVALIDATION_CHANNEL, () => {
                    cachedRegistry = null
                    registryGeneration++
                    log.debug('[qadamCache] Registry invalidated via pubsub')
                })
            }
        },

        async loadRegistry(): Promise<QadamRegistryEntry[]> {
            const persistedRegistry = await loadPersistedRegistry()
            const bundledQadams = (await loadBundledQadams(log)).map(toRegistryEntry)
            const officialQadamsInstallEnabled = isOfficialQadamsInstallEnabled()
            const bundledShadowKeys = new Set(bundledQadams.map((q) => shadowKey({ name: q.name, version: q.version, officialQadamsInstallEnabled })))
            const persistedWithoutBundled = persistedRegistry.filter((q) => !bundledShadowKeys.has(shadowKey({ name: q.name, version: q.version, officialQadamsInstallEnabled })))
            return [...persistedWithoutBundled, ...bundledQadams]
        },

        async invalidate(): Promise<void> {
            cachedRegistry = null
            registryGeneration++
            if (!isTestingEnvironment) {
                await pubsub.publish(QADAM_REGISTRY_INVALIDATION_CHANNEL, '1')
            }
        },
    }
}

// Exported so every site that shadows a persisted row by a bundled qadam's name agrees on the
// key — `fetchLatestQadams` in `qadam-metadata-service.ts` used to key on name alone independently
// of this file, which meant a lookalike row could be hidden from `GET /v1/qadams` while remaining
// resolvable (and executable) through `get()`/`registry()`. Tied to the same flag as
// `needsInstalling()` in the worker (`qadam-installer.ts`), not gated independently: `false` (the
// default, until #475/#476 publish official qadams AND #482's dependency-confusion preconditions
// are met — see the comment on `needsInstalling` for why that second precondition matters) keeps
// shadowing by name alone, which is today's exact behavior and also masks the one persisted row
// that can already collide with a bundled name — a platform installing a CUSTOM qadam under a name
// a bundled qadam also uses. `true` keys by `name@version` instead, the switch #477 needs so a
// persisted official version survives next to a bundled one at a different version.
export function shadowKey({ name, version, officialQadamsInstallEnabled }: {
    name: string
    version: string
    officialQadamsInstallEnabled: boolean
}): string {
    return officialQadamsInstallEnabled ? `${name}@${version}` : name
}

export function isOfficialQadamsInstallEnabled(): boolean {
    // `?? false` is unreachable given `systemPropDefaultValues` already defaults this prop to
    // `'false'` (`system.ts`) — kept as deliberate belt-and-braces against that default ever being
    // removed, not dead code.
    return system.getBoolean(AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED) ?? false
}

async function loadPersistedRegistry(): Promise<QadamRegistryEntry[]> {
    if (isTestingEnvironment) {
        return fetchRegistryFromDB()
    }
    if (!isNil(cachedRegistry)) {
        return cachedRegistry
    }
    const startGeneration = registryGeneration
    const result = await fetchRegistryFromDB()
    if (registryGeneration !== startGeneration) {
        return loadPersistedRegistry()
    }
    cachedRegistry = result
    return result
}

function toRegistryEntry(qadam: QadamMetadataSchema): QadamRegistryEntry {
    return {
        name: qadam.name,
        version: qadam.version,
        minimumSupportedRelease: qadam.minimumSupportedRelease,
        maximumSupportedRelease: qadam.maximumSupportedRelease,
        platformId: qadam.platformId,
        qadamType: qadam.qadamType,
    }
}

async function fetchRegistryFromDB(): Promise<QadamRegistryEntry[]> {
    return repo()
        .createQueryBuilder('pm')
        .select('pm.name', 'name')
        .addSelect('pm.version', 'version')
        .addSelect('pm.platformId', 'platformId')
        .addSelect('pm.qadamType', 'qadamType')
        .addSelect('pm.minimumSupportedRelease', 'minimumSupportedRelease')
        .addSelect('pm.maximumSupportedRelease', 'maximumSupportedRelease')
        .getRawMany<QadamRegistryEntry>()
}

export const QADAM_REGISTRY_INVALIDATION_CHANNEL = 'qadam-registry-invalidation'

export type QadamRegistryEntry = {
    platformId?: string
    qadamType: QadamType
    name: string
    version: string
    minimumSupportedRelease?: string
    maximumSupportedRelease?: string
}
