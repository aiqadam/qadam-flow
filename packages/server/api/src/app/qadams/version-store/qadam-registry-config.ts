import { safeHttp } from '@aiqadam/server-utils'
import { isNil } from '@aiqadam/shared'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'
const REACHABILITY_TIMEOUT_MS = 5_000

// ADR-0003 "Registry at install": where a non-`@aiqadam` / custom qadam version is fetched from
// when the store does not hold it (#806), and what `run.sh`'s install-time check (#807) probes.
// `@aiqadam/*` fetches always go to npmjs with a mandatory signature check (ADR-0003, ADR-0005)
// regardless of this setting — a configured registry is for everything else.
//
// The token is a secret end to end: `get()` returns it so a caller can authenticate a request, but
// nothing here — and nothing a caller does with the result — may pass it to a logger. Log `url` and
// `hasToken` only, never `token`.
export const qadamRegistryConfig = {
    get: (): QadamRegistryConfig => {
        const url = system.get<string>(AppSystemProp.QADAM_REGISTRY_URL) ?? DEFAULT_REGISTRY_URL
        const token = system.get<string>(AppSystemProp.QADAM_REGISTRY_TOKEN) ?? null
        return { url, token }
    },

    isDefault: ({ url }: { url: string }): boolean => normalize({ url }) === normalize({ url: DEFAULT_REGISTRY_URL }),

    // Never throws: a registry being unreachable is something a caller reports, not a fault. Any
    // HTTP response at all — even a 404 or 401 — means the host answered, so only a network-level
    // failure (DNS, TCP, TLS, timeout) counts as unreachable. The request goes through `safeHttp`,
    // because the URL is admin-configured (`.agents/rules/safe-http.md`), and the token travels only
    // as a bearer header, never in the returned result.
    checkReachability: async ({ url, token }: QadamRegistryConfig): Promise<QadamRegistryReachability> => {
        const client = safeHttp.createAxios({
            timeout: REACHABILITY_TIMEOUT_MS,
            headers: isNil(token) ? undefined : { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
        })
        try {
            await client.get(new URL('-/ping', ensureTrailingSlash({ url })).toString())
            return { reachable: true }
        }
        catch (error) {
            return { reachable: false, reason: error instanceof Error ? error.message : 'unknown error' }
        }
    },
}

function normalize({ url }: { url: string }): string {
    return url.trim().replace(/\/+$/, '').toLowerCase()
}

function ensureTrailingSlash({ url }: { url: string }): string {
    return url.endsWith('/') ? url : `${url}/`
}

export type QadamRegistryConfig = {
    url: string
    token: string | null
}

export type QadamRegistryReachability =
    | { reachable: true }
    | { reachable: false, reason: string }
