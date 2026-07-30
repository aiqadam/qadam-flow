import { environmentMigrations } from '@aiqadam/server-utils'
import { from } from 'env-var'

function env() {
    return from(environmentMigrations.migrate())
}

function getApiUrl(): string {
    return getInternalAppBaseUrl() + '/api/'
}

function getSocketUrl(): { url: string, path: string } {
    return { url: getInternalAppBaseUrl(), path: '/api/socket.io' }
}

function getInternalAppBaseUrl(): string {
    const workerApiUrl = system.get(WorkerSystemProp.WORKER_API_URL)
    if (workerApiUrl) {
        return workerApiUrl.replace(/\/+$/, '')
    }
    return system.getOrThrow(WorkerSystemProp.FRONTEND_URL).replace(/\/+$/, '')
}

export enum WorkerSystemProp {
    FRONTEND_URL = 'AP_FRONTEND_URL',
    WORKER_API_URL = 'AP_WORKER_API_URL',
    CONTAINER_TYPE = 'AP_CONTAINER_TYPE',
    WORKER_TOKEN = 'AP_WORKER_TOKEN',
    PORT = 'AP_PORT',
    LOG_LEVEL = 'AP_LOG_LEVEL',
    LOG_PRETTY = 'AP_LOG_PRETTY',
    OTEL_ENABLED = 'AP_OTEL_ENABLED',
    LOAD_TRANSLATIONS_FOR_DEV_QADAMS = 'AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS',
    WORKER_GROUP_ID = 'AP_WORKER_GROUP_ID',
    WORKER_CONCURRENCY = 'AP_WORKER_CONCURRENCY',
    EXECUTION_MODE = 'AP_EXECUTION_MODE',
    REUSE_SANDBOX = 'AP_REUSE_SANDBOX',
}

const defaultValues: Partial<Record<WorkerSystemProp, string>> = {
    [WorkerSystemProp.PORT]: '3000',
    [WorkerSystemProp.LOG_LEVEL]: 'info',
    [WorkerSystemProp.LOG_PRETTY]: 'false',
    [WorkerSystemProp.OTEL_ENABLED]: 'false',
    [WorkerSystemProp.WORKER_CONCURRENCY]: '5',
}

export const system = {
    get(prop: WorkerSystemProp): string | undefined {
        return env().get(prop).asString() ?? defaultValues[prop]
    },
    // Same reasoning as system.getContainerType() in the api package: an unrecognised value must
    // stop the process rather than silently fall through a `=== 'WORKER'` comparison, which would
    // start a worker with its health server switched off and no indication why.
    getContainerType(): ContainerType {
        const value = env().get(WorkerSystemProp.CONTAINER_TYPE).asString()?.trim()
        if (!value) {
            throw new Error(`AP_CONTAINER_TYPE is required and has no default. Set it to ${containerTypes.join(' or ')}; the API server and the worker run as separate processes. See https://flow.aiqadam.org/docs/install/configuration/environment-variables.`)
        }
        if (!isContainerType(value)) {
            const removedHint = value === 'WORKER_AND_APP'
                ? ' WORKER_AND_APP has been removed — run the API and the worker as separate processes.'
                : ''
            throw new Error(`Invalid AP_CONTAINER_TYPE="${value}". Expected one of: ${containerTypes.join(', ')} (case-sensitive).${removedHint} See https://flow.aiqadam.org/docs/install/configuration/breaking-changes.`)
        }
        return value
    },
    getOrThrow(prop: WorkerSystemProp): string {
        return env().get(prop).required().asString()
    },
    getBoolean(prop: WorkerSystemProp): boolean | undefined {
        return env().get(prop).asBoolStrict()
    },
    getList(prop: WorkerSystemProp): string[] {
        const value = env().get(prop).asString() ?? defaultValues[prop]
        return value ? value.split(',').map(s => s.trim()).filter(Boolean) : []
    },
}

// Mirrors ContainerType in the api package. Both packages depend on @aiqadam/server-utils, so
// this could be shared there — deliberately not, because two values and one env name is less
// coupling than a third package in the boot path of both deployables. The cost is that the two
// copies can drift; worker/test/lib/configs.test.ts pins the accepted set on this side.
const containerTypes = ['APP', 'WORKER'] as const

function isContainerType(value: string): value is ContainerType {
    return containerTypes.some((candidate) => candidate === value)
}

export type ContainerType = typeof containerTypes[number]

export { getApiUrl, getSocketUrl }
