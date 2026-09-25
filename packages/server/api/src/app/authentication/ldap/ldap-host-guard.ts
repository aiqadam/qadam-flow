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
const METADATA_ADDRESSES = ['169.254.169.254', 'fd00:ec2::254']

function isCloudMetadataAddress(ip: string): boolean {
    const addr = ipaddr.parse(ip)
    return METADATA_ADDRESSES.some((metadataIp) => addr.toString() === ipaddr.parse(metadataIp).toString())
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

// Each family is resolved independently and a failure on one (e.g. no AAAA record, the common
// case) does not sink the other — only the combined, empty result counts as unresolvable to the
// caller.
async function resolveHostname(host: string): Promise<string[]> {
    const [ipv4, ipv6] = await Promise.all([
        dns.resolve4(host).catch(() => [] as string[]),
        dns.resolve6(host).catch(() => [] as string[]),
    ])
    return [...ipv4, ...ipv6]
}

export const ldapHostGuard = {
    resolveVettedIps,
}

type ResolveVettedIpsParams = {
    host: string
}
