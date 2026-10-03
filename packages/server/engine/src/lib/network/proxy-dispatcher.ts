import { Agent, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import { collapseDuplicateContentLength } from './content-length-interceptor'
import { EGRESS_PROXY_URL_ENV } from './global-agent-proxy'
import type { UninstallFn } from './ssrf-guard'

// Importing npm undici already makes its own Agent the global dispatcher behind the built-in fetch,
// in every network mode, so the engine always installs one that carries the content-length shim.
// Only the STRICT path (`useEgressProxy`) routes through the egress proxy.
export function installEngineDispatcher({ useEgressProxy }: InstallEngineDispatcherParams): UninstallFn {
    const proxyUrl = useEgressProxy ? process.env[EGRESS_PROXY_URL_ENV] : undefined
    const originalDispatcher = getGlobalDispatcher()
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent()
    setGlobalDispatcher(dispatcher.compose(collapseDuplicateContentLength))
    return () => setGlobalDispatcher(originalDispatcher)
}

type InstallEngineDispatcherParams = {
    useEgressProxy: boolean
}
