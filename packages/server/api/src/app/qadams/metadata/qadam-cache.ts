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
            const bundledNames = new Set(bundledQadams.map((q) => q.name))
            const persistedWithoutBundled = persistedRegistry.filter((q) => !bundledNames.has(q.name))
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
        .select(['pm.name', 'pm.version', 'pm.platformId', 'pm.qadamType', 'pm.minimumSupportedRelease', 'pm.maximumSupportedRelease'])
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
