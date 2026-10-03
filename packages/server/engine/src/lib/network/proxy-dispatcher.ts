import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { EGRESS_PROXY_URL_ENV } from './global-agent-proxy'
import type { UninstallFn } from './ssrf-guard'

// Only the STRICT path (`useEgressProxy`) with an egress proxy swaps the dispatcher for a
// ProxyAgent. Otherwise the installed dispatcher is left alone, so an EnvHttpProxyAgent Node set up
// from NODE_USE_ENV_PROXY + HTTP(S)_PROXY keeps routing user code through the operator's proxy.
export function installEngineDispatcher({ useEgressProxy }: InstallEngineDispatcherParams): UninstallFn {
    const proxyUrl = useEgressProxy ? process.env[EGRESS_PROXY_URL_ENV] : undefined
    if (!proxyUrl) {
        return () => undefined
    }
    const originalDispatcher = getGlobalDispatcher()
    setGlobalDispatcher(new ProxyAgent(proxyUrl))
    return () => setGlobalDispatcher(originalDispatcher)
}

type InstallEngineDispatcherParams = {
    useEgressProxy: boolean
}
