import { tryCatchSync } from '@aiqadam/shared'
import { FastifyRequest } from 'fastify'
import { networkUtils } from './network-utils'
import { system } from './system/system'
import { AppSystemProp } from './system/system-props'

export const domainHelper = {
    async getPublicUrl({ path }: PublicUrlParams): Promise<string> {
        return networkUtils.combineUrl(system.getOrThrow(AppSystemProp.FRONTEND_URL), path ?? '')
    },
    getPublicUrlFromRequest({ req, path }: PublicUrlFromRequestParams): string {
        const requestBase = networkUtils.getRequestBaseUrl(req)
        const baseWithPrefix = networkUtils.combineUrl(requestBase, getConfiguredBasePath())
        return cleanTrailingSlash(networkUtils.combineUrl(baseWithPrefix, path ?? ''))
    },
    async getPublicApiUrl({ path }: PublicUrlParams): Promise<string> {
        return domainHelper.getPublicUrl({ path: `/api/${cleanLeadingSlash(path ?? '')}` })
    },
    async getInternalUrl({ path }: InternalUrlParams): Promise<string> {
        const internalUrl = system.get(AppSystemProp.INTERNAL_URL)
        if (internalUrl) {
            return networkUtils.combineUrl(internalUrl, path ?? '')
        }
        return this.getPublicUrl({ path })
    },
    async getInternalApiUrl({ path }: InternalUrlParams): Promise<string> {
        return this.getInternalUrl({ path: `/api/${cleanLeadingSlash(path ?? '')}` })
    },
    async getApiUrlForWorker({ path }: PublicUrlParams): Promise<string> {
        const hasWorkerModule = system.isWorker()
        if (hasWorkerModule) {
            const port = system.get(AppSystemProp.PORT)
            return networkUtils.combineUrl(`http://127.0.0.1:${port}/api`, path ?? '')
        }
        return this.getInternalApiUrl({ path: path ?? '' })
    },
    // For a call that both originates from and is only ever handled by this
    // same running process (e.g. callFlow's queue-mode wait-for-response
    // resume, POSTed by the child flow's own Return Response step back into
    // this instance) — not AppSystemProp.INTERNAL_URL, which is an operator-
    // configured address for cross-instance internal traffic and isn't
    // guaranteed to route back to loopback (in CE integration tests it's set
    // to a fixed dev port that doesn't match the test harness's actual
    // per-run listen port, so using it here made a same-process call target
    // the wrong port entirely). 127.0.0.1 plus this process's own configured
    // listen port is correct in every topology this can run in — bundled
    // docker-compose, native dev, or a test harness's dynamic port.
    async getSelfApiUrl({ path }: PublicUrlParams): Promise<string> {
        const port = system.get(AppSystemProp.PORT)
        return networkUtils.combineUrl(`http://127.0.0.1:${port}/api`, path ?? '')
    },
}

function cleanLeadingSlash(path: string) {
    return path.startsWith('/') ? path.slice(1) : path
}

function cleanTrailingSlash(url: string) {
    return url.endsWith('/') ? url.slice(0, -1) : url
}

function getConfiguredBasePath(): string {
    const { data: url } = tryCatchSync(() => new URL(system.getOrThrow(AppSystemProp.FRONTEND_URL)))
    return url && url.pathname !== '/' ? url.pathname : ''
}

type PublicUrlParams = {
    path?: string
}

type PublicUrlFromRequestParams = {
    req: FastifyRequest
    path?: string
}

type InternalUrlParams = {
    path: string
}
