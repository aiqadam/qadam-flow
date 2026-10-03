import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { collapseDuplicateContentLength } from './content-length-interceptor'
import { EGRESS_PROXY_URL_ENV } from './global-agent-proxy'
import type { UninstallFn } from './ssrf-guard'

// Every mode gets the content-length shim. Only the STRICT path (`useEgressProxy`) with an egress
// proxy swaps the dispatcher for a ProxyAgent; otherwise the shim wraps whatever is already
// installed, so an EnvHttpProxyAgent Node set up from NODE_USE_ENV_PROXY + HTTP(S)_PROXY keeps
// routing user code through the operator's proxy.
export function installEngineDispatcher({ useEgressProxy }: InstallEngineDispatcherParams): UninstallFn {
    const proxyUrl = useEgressProxy ? process.env[EGRESS_PROXY_URL_ENV] : undefined
    const originalDispatcher = getGlobalDispatcher()
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : originalDispatcher
    setGlobalDispatcher(dispatcher.compose(collapseDuplicateContentLength))
    return () => setGlobalDispatcher(originalDispatcher)
}

type InstallEngineDispatcherParams = {
    useEgressProxy: boolean
}
