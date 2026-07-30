import dns from 'node:dns'
import { omit, SSRFBlockedError, ssrfIpClassifier } from '@aiqadam/shared'
import type { GuardPolicy, UninstallFn } from './ssrf-guard'

export function installDnsLookupGuard(policy: GuardPolicy): UninstallFn {
    const originalLookup = dns.lookup
    const originalPromisesLookup = dns.promises.lookup
    const boundLookup = originalLookup.bind(dns) as typeof dns.lookup
    const boundPromisesLookup = originalPromisesLookup.bind(dns.promises) as typeof dns.promises.lookup

    const guardedLookup = buildGuardedCallbackLookup({ policy, boundLookup })
    // Preserve util.promisify.custom + __promisify__ that Node attaches to the original
    // callback-style `lookup` — otherwise `dns.promises.lookup` re-derivation breaks.
    Object.assign(guardedLookup, originalLookup)

    const guardedPromisesLookup = buildGuardedPromiseLookup({ policy, boundPromisesLookup })

    assignLookup(dns, guardedLookup)
    assignPromisesLookup(dns.promises, guardedPromisesLookup)

    return () => {
        assignLookup(dns, originalLookup)
        assignPromisesLookup(dns.promises, originalPromisesLookup)
    }
}

function buildGuardedCallbackLookup({ policy, boundLookup }: BuildCallbackLookupParams): GuardedCallbackLookup {
    return function lookup(
        hostname: string,
        optionsOrCallback: number | dns.LookupOptions | DnsLookupCallback,
        maybeCallback?: DnsLookupCallback,
    ): void {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        const callerOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
        const requestedFamily = readRequestedFamily({ options: callerOptions })
        const wantsAll = typeof callerOptions === 'object' && callerOptions !== null && Boolean(callerOptions.all)

        const onResolved: DnsLookupCallback = (err, address, family) => {
            if (err || !callback) {
                callback?.(err, address, family)
                return
            }
            const entries = toAddressList({ address, family })
            // Map before filtering: a v4 record only survives a family-6 filter once it has been
            // rewritten to its ::ffff: form, which is exactly what AI_V4MAPPED asks for.
            const matching = filterByFamily({ entries: applyV4Mapped({ entries, family: requestedFamily, options: callerOptions }), family: requestedFamily })
            // Checked AFTER the family filter, on exactly the set that can be returned. Checking
            // every family instead looks stronger and is not: it rejects a host whose *other*
            // family is blocked even though that address can never be handed to the caller, which
            // breaks AP_SSRF_ALLOW_LIST — allow-listing 127.0.0.1 and asking for family 4 fails on
            // a dual-stack box because ::1 is not in the list. CI caught exactly that. Every
            // address that leaves this function is still checked, which is the property that matters.
            const blocked = findBlockedEntry({ entries: matching, allowList: policy.allowList })
            if (blocked) {
                callback(buildBlockedError({ host: hostname, ip: blocked.address }), '', 0)
                return
            }
            if (requestedFamily !== undefined && matching.length === 0) {
                callback(buildNotFoundError({ host: hostname }), '', 0)
                return
            }
            if (wantsAll) {
                callback(null, matching)
                return
            }
            const first = matching[0]
            if (!first) {
                callback(null, '', 0)
                return
            }
            callback(null, first.address, first.family)
        }

        boundLookup(hostname, buildResolverOptions({ options: callerOptions }), onResolved)
    } as GuardedCallbackLookup
}

function buildGuardedPromiseLookup({ policy, boundPromisesLookup }: BuildPromiseLookupParams): GuardedPromiseLookup {
    return async function promiseLookup(hostname: string, options?: number | dns.LookupOptions) {
        const requestedFamily = readRequestedFamily({ options })
        const wantsAll = typeof options === 'object' && options !== null && Boolean(options.all)

        const allEntries = await boundPromisesLookup(hostname, buildResolverOptions({ options }))
        // Map before filtering, and check after — see the notes in the callback variant.
        const matching = filterByFamily({ entries: applyV4Mapped({ entries: allEntries, family: requestedFamily, options }), family: requestedFamily })
        const blocked = findBlockedEntry({ entries: matching, allowList: policy.allowList })
        if (blocked) {
            throw buildBlockedError({ host: hostname, ip: blocked.address })
        }
        if (requestedFamily !== undefined && matching.length === 0) {
            throw buildNotFoundError({ host: hostname })
        }
        return wantsAll ? matching : matching[0]
    } as GuardedPromiseLookup
}

// The resolver is always asked for every family, so the block-list check below sees every
// address the host has — narrowing at the resolver would hide records from it. The caller's
// family is honoured by filtering the *result* instead.
function buildResolverOptions({ options }: ReadFamilyParams): dns.LookupAllOptions {
    if (typeof options !== 'object' || options === null) return { all: true }
    return { ...omit(options, ['family']), all: true }
}

// Node accepts the family as 4/6, as the strings 'IPv4'/'IPv6', or as 0 for "any". The string
// spellings are documented and were honoured before this guard started filtering the result
// instead of narrowing the resolver — missing them here would drop them silently and hand an
// IPv6 address to a caller that asked for IPv4, which is the exact defect #248 is about.
function readRequestedFamily({ options }: ReadFamilyParams): number | undefined {
    const family = typeof options === 'number' ? options : options?.family
    if (family === 'IPv4') return 4
    if (family === 'IPv6') return 6
    // 0 is dns.lookup's "any family" and must not filter anything out.
    return family === 4 || family === 6 ? family : undefined
}

// getaddrinfo honours AI_V4MAPPED (and AI_ALL) only when the family is AF_INET6, and this guard
// deliberately does not pass the family to the resolver — so the hint would silently become inert
// and the family filter would then empty the list, turning a lookup that used to return
// `::ffff:a.b.c.d` into ENOTFOUND. Mapping here reproduces what the resolver would have done.
// The block-list check has already run against the unmapped v4 address, which is the stricter
// form to check, so this cannot smuggle an unchecked address through.
function applyV4Mapped({ entries, family, options }: ApplyV4MappedParams): dns.LookupAddress[] {
    if (family !== 6 || typeof options !== 'object' || options === null) return entries
    const hints = options.hints ?? 0
    if ((hints & dns.V4MAPPED) === 0) return entries
    return entries.map((entry) => entry.family === 4
        ? { address: `::ffff:${entry.address}`, family: 6 }
        : entry)
}

function filterByFamily({ entries, family }: FilterByFamilyParams): dns.LookupAddress[] {
    if (family === undefined) return entries
    return entries.filter((entry) => entry.family === family)
}

// Node's resolver reports a family with no matching records as ENOTFOUND rather than an empty
// result, so callers that branch on `err.code` keep working when the filter empties the list.
function buildNotFoundError({ host }: BuildNotFoundErrorParams): DnsNotFoundError {
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        errno: UV_EAI_NODATA,
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: host,
    })
}

function toAddressList({ address, family }: ToAddressListParams): dns.LookupAddress[] {
    if (Array.isArray(address)) return address
    return [{ address: address as string, family: family ?? 4 }]
}

function findBlockedEntry({ entries, allowList }: FindBlockedEntryParams): dns.LookupAddress | undefined {
    return entries.find((entry) => ssrfIpClassifier.isBlockedIp({ ip: entry.address, allowList }))
}

function buildBlockedError({ host, ip }: BuildBlockedErrorParams): SSRFBlockedError {
    return new SSRFBlockedError({ host, ip })
}

function assignLookup(target: typeof dns, fn: typeof dns.lookup): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (target as any).lookup = fn
}

function assignPromisesLookup(target: typeof dns.promises, fn: typeof dns.promises.lookup): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (target as any).lookup = fn
}

// libuv's UV_EAI_NODATA. Node maps both EAI_NODATA and EAI_NONAME to code 'ENOTFOUND' while
// keeping the raw errno, and a real `dns.lookup(host, 6)` against a host with no AAAA yields
// -3007 — so this value, not UV_EAI_NONAME's -3008, is the one that matches. Named correctly
// on purpose: the previous name invited a "fix" to -3008 that would have changed the semantics.
const UV_EAI_NODATA = -3007

type DnsLookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

type DnsNotFoundError = NodeJS.ErrnoException & { hostname: string }

type ReadFamilyParams = {
    options?: number | dns.LookupOptions | undefined
}

type ApplyV4MappedParams = {
    entries: dns.LookupAddress[]
    family: number | undefined
    options?: number | dns.LookupOptions
}

type FilterByFamilyParams = {
    entries: dns.LookupAddress[]
    family?: number
}

type BuildNotFoundErrorParams = {
    host: string
}

type GuardedCallbackLookup = typeof dns.lookup

type GuardedPromiseLookup = typeof dns.promises.lookup

type BuildCallbackLookupParams = {
    policy: GuardPolicy
    boundLookup: typeof dns.lookup
}

type BuildPromiseLookupParams = {
    policy: GuardPolicy
    boundPromisesLookup: typeof dns.promises.lookup
}

type ToAddressListParams = {
    address: string | dns.LookupAddress[]
    family?: number
}

type FindBlockedEntryParams = {
    entries: dns.LookupAddress[]
    allowList: string[]
}

type BuildBlockedErrorParams = {
    host: string
    ip: string
}
