import dns from 'node:dns/promises'
import { safeHttp } from '@aiqadam/server-utils'
import { isNil, LdapTestStage, ssrfIpClassifier } from '@aiqadam/shared'
import ipaddr from 'ipaddr.js'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { LdapStageError } from './ldap-stage-error'

// A directory server almost always lives on the same private network the SSRF filter exists to
// keep code steps and outbound-webhook qadams out of — an operator's domain controllers are
// squarely inside RFC 1918 space. `AP_SSRF_ALLOW_LIST` stays scoped to what an admin explicitly
// vetted for arbitrary outbound HTTP; this is a second, LDAP-only list so approving the directory
// does not also open every private subnet to every HTTP-capable qadam.
function getLdapAllowList(): string[] {
    return safeHttp.parseAllowList(system.get(AppSystemProp.LDAP_ALLOW_LIST))
}

// `ssrfIpClassifier.isBlockedIp` treats its allow list as an unconditional override — by design,
// for the general-purpose SSRF filter, where an operator may have a real reason to reach a
// specific link-local service. LDAP's own requirement is narrower and absolute: the handful of
// well-known cloud metadata endpoints must never be reachable through this feature, allow-listed
// or not, because unlike an arbitrary internal service there is no legitimate reason for a
// directory bind to ever need one. Checked ahead of, and independent of, the allow list.
// `169.254.169.254` covers AWS/GCP/Azure; `169.254.170.2` is AWS ECS's task metadata endpoint;
// `100.100.100.200` is Alibaba Cloud's; `fd00:ec2::254` is AWS's IPv6 metadata address.
const METADATA_ADDRESSES = ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']

function isCloudMetadataAddress(ip: string): boolean {
    const canonical = toCanonicalIpv4String(ipaddr.parse(ip))
    return METADATA_ADDRESSES.some((metadataIp) => canonical === toCanonicalIpv4String(ipaddr.parse(metadataIp)))
}

// An IPv4-mapped IPv6 literal (`::ffff:169.254.169.254`) is the *same* address as its IPv4 form as
// far as the kernel and the directory server are concerned, but `IPv6#toString()` prints it back
// out with the `::ffff:` prefix, so a naive string comparison against the plain IPv4 metadata
// addresses above would silently let this form through. Unwrapping to the IPv4 form first (when
// the parsed address is one) is what makes the comparison see through the wrapper either way.
function toCanonicalIpv4String(addr: ReturnType<typeof ipaddr.parse>): string {
    if ('isIPv4MappedAddress' in addr && addr.isIPv4MappedAddress()) {
        return addr.toIPv4Address().toString()
    }
    return addr.toString()
}

// Resolves every A/AAAA record for the host and vets each one individually — a multi-homed name
// with even one address inside a blocked range (private, loopback, link-local, or cloud metadata)
// is refused outright, rather than connecting to whichever address the resolver or the OS
// happened to try first. An IP literal in the config is classified directly, with no DNS lookup at
// all, which also closes the classic resolve-then-reconnect TOCTOU window a hostname-based check
// would otherwise leave open between "the name was vetted" and "the socket connects".
async function resolveVettedIps({ host }: ResolveVettedIpsParams): Promise<string[]> {
    const allowList = getLdapAllowList()
    const literal = ipaddr.isValid(host) ? host : null
    const candidateIps = !isNil(literal) ? [literal] : await resolveHostname(host)

    if (candidateIps.length === 0) {
        throw new LdapStageError({
            stage: LdapTestStage.ALLOW_LIST,
            message: `Could not resolve any address for "${host}"`,
        })
    }

    const metadataIp = candidateIps.find(isCloudMetadataAddress)
    if (!isNil(metadataIp)) {
        throw new LdapStageError({
            stage: LdapTestStage.ALLOW_LIST,
            message: `Address ${metadataIp} for "${host}" is a cloud metadata address and can never be used, regardless of AP_LDAP_ALLOW_LIST.`,
        })
    }

    const blockedIp = candidateIps.find((ip) => ssrfIpClassifier.isBlockedIp({ ip, allowList }))
    if (!isNil(blockedIp)) {
        throw new LdapStageError({
            stage: LdapTestStage.ALLOW_LIST,
            message: `Address ${blockedIp} for "${host}" is not allowed. Add it (or a covering CIDR) to AP_LDAP_ALLOW_LIST if it is a trusted directory.`,
        })
    }

    return candidateIps
}

// `dns.lookup` (the OS resolver — `getaddrinfo(3)`) rather than `dns.resolve4`/`resolve6` (which
// query a DNS server directly): the latter skips `/etc/hosts` entirely, so an operator's own
// `extra_hosts` entry for an internal directory hostname — the normal way to pin a private domain
// controller's address in a container without standing up split-horizon DNS — would resolve for
// every other outbound feature in this process but silently fail here. `{ all: true }` is the
// A/AAAA-both-families equivalent under this single call. An unresolvable host throws inside
// `dns.lookup` itself, so the `.catch` below has the same "empty means unresolvable" contract the
// caller already checks for.
async function resolveHostname(host: string): Promise<string[]> {
    const results = await dns.lookup(host, { all: true }).catch(() => [])
    return results.map((result) => result.address)
}

export const ldapHostGuard = {
    resolveVettedIps,
}

type ResolveVettedIpsParams = {
    host: string
}
