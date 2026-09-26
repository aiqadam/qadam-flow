import tls from 'node:tls'
import { isNil, LdapAttributeMap, LdapConfig, LdapTestStage, LdapTlsMode, matchesTlsScheme, unique } from '@aiqadam/shared'
import ipaddr from 'ipaddr.js'
import { Client, Entry, ResultCodeError } from 'ldapts'
import { system } from '../../helper/system/system'
import { ldapAttributeUtils } from './ldap-attributes'
import { ldapFilterUtils } from './ldap-filter'
import { ldapHostGuard } from './ldap-host-guard'
import { LdapStageError } from './ldap-stage-error'

export const ldapClient = {
    connect,
    serviceBind,
    searchForUser,
    searchNestedGroups,
    searchBySubject,
    resolveMemberGroupDns,
    bindAsUser,
    withConnectionSlot,
}

// RFC 4511/4513 give a directory server 5s of goodwill for any single operation before the caller
// is entitled to conclude it is unreachable, and a sign-in request holding a connection open
// indefinitely is itself an availability risk. All operations below share this one bound rather
// than each picking their own — including the StartTLS handshake itself, which `ldapts` places no
// deadline on at all (see `withStartTlsTimeout` below).
const LDAP_OPERATION_TIMEOUT_MS = 5000

// A single admin `/test` click, or a burst of concurrent sign-ins, must not be able to open an
// unbounded number of sockets to the directory. This throttles connection attempts process-wide;
// a request past the cap waits for a free slot rather than failing outright, bounded by
// `CONNECTION_SLOT_WAIT_TIMEOUT_MS` below. The slot is held by the caller for the connection's
// *entire* lifetime (connect through unbind, not just the connect step), so this cap is a genuine
// bound on concurrently open connections, not merely concurrent in-flight connects.
const MAX_CONCURRENT_LDAP_CONNECTIONS = 10
// A request that cannot get a slot within this bound fails outright rather than queuing
// indefinitely — the same 5s goodwill window every other LDAP operation gets.
const CONNECTION_SLOT_WAIT_TIMEOUT_MS = LDAP_OPERATION_TIMEOUT_MS
// Caps the waiter queue itself, independent of the per-waiter timeout above: without this, a
// large burst of requests arriving faster than `MAX_CONCURRENT_LDAP_CONNECTIONS` can drain them
// would still queue every one of them (each eventually timing out on its own), holding open that
// many pending promises/timers at once. Rejecting outright once the queue is already full bounds
// that memory/timer cost directly instead of only bounding how long each waiter lives.
const MAX_CONNECTION_SLOT_WAITERS = 50
// One connection attempt tries at most this many of the vetted IPs before giving up — a
// multi-homed name with many records must not turn one sign-in attempt into an unbounded number
// of connection attempts (each with its own 5s connect timeout).
const MAX_VETTED_IPS_PER_ATTEMPT = 4

let activeConnections = 0
const connectionWaiters: Array<() => void> = []

async function acquireConnectionSlot(): Promise<void> {
    if (activeConnections < MAX_CONCURRENT_LDAP_CONNECTIONS) {
        activeConnections += 1
        return
    }
    if (connectionWaiters.length >= MAX_CONNECTION_SLOT_WAITERS) {
        throw new LdapStageError({
            stage: LdapTestStage.CONNECT,
            message: 'Too many LDAP connection attempts are already waiting for a free connection slot',
        })
    }
    await new Promise<void>((resolve, reject) => {
        // `waiter` is what `releaseConnectionSlot` hands the freed slot to directly — see the note
        // there for why this, not a decrement-then-increment pair, is what closes the off-by-one.
        const waiter = (): void => {
            clearTimeout(timer)
            resolve()
        }
        const timer = setTimeout(() => {
            const index = connectionWaiters.indexOf(waiter)
            if (index !== -1) {
                // Not yet handed a slot — remove this waiter so a later `releaseConnectionSlot`
                // does not resolve an abandoned promise instead of the next real waiter in line.
                connectionWaiters.splice(index, 1)
            }
            reject(new LdapStageError({
                stage: LdapTestStage.CONNECT,
                message: `Timed out after ${CONNECTION_SLOT_WAIT_TIMEOUT_MS}ms waiting for a free LDAP connection slot`,
            }))
        }, CONNECTION_SLOT_WAIT_TIMEOUT_MS)
        connectionWaiters.push(waiter)
    })
}

// The previous shape decremented `activeConnections` unconditionally, then popped and resolved a
// waiter — but resolving a waiter is only a promise settling; the waiter's own continuation
// (back in `acquireConnectionSlot`) used to run *another* `activeConnections += 1` afterwards.
// Between the decrement here and that increment there, `activeConnections` was transiently under
// the cap, so a second, unrelated `acquireConnectionSlot` call arriving in that window could see
// a free slot and take it via the fast path — at which point both it *and* the waiter this
// function just woke would end up holding a slot for what was really one freed slot, one over
// the cap. Handing the slot directly to a waiter when one exists — never decrementing — closes
// that window: the slot count only ever changes on a genuine acquire-under-cap or a
// release-with-no-waiter, never on a handoff.
function releaseConnectionSlot(): void {
    const next = connectionWaiters.shift()
    if (!isNil(next)) {
        next()
        return
    }
    activeConnections -= 1
}

async function withConnectionSlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquireConnectionSlot()
    try {
        return await fn()
    }
    finally {
        releaseConnectionSlot()
    }
}

// Connects to the first vetted IP (capped at `MAX_VETTED_IPS_PER_ATTEMPT`) that accepts a
// TCP/TLS handshake, presenting the *hostname* as the TLS `servername` even though the socket
// dials the IP literal — ldapts never derives `servername` on our behalf. For `ldaps://`,
// `_connect()` calls `tls.connect(port, host, tlsOptions)`, and Node only defaults `servername`
// to that `host` argument when it is not itself an IP literal — which it is here, since we dial
// the vetted IP directly — so an explicit `tlsOptions.servername` is the only thing standing
// between this connection and either silently skipped SNI or a certificate check against the IP
// instead of the configured hostname. For `startTLS()`, there is no default at all: the upgrade
// runs the caller-supplied options straight through `tls.connect` over an already-open plain
// socket, which carries no host of its own.
async function connect({ config }: ConnectParams): Promise<Client> {
    if (!matchesTlsScheme({ url: config.url, tlsMode: config.tlsMode })) {
        // Defense in depth: `LdapConfig`'s own `superRefine` already refuses this combination at
        // save time, but a row written before that check existed, or directly to the database,
        // must not reach the wire as a silent downgrade either.
        throw new LdapStageError({
            stage: LdapTestStage.CONNECT,
            message: `The configured URL scheme does not match tlsMode "${config.tlsMode}"`,
        })
    }

    const url = new URL(config.url)
    // `URL#hostname` keeps the brackets around an IPv6 literal (`"[::1]"`) — passing that straight
    // through would make `ipaddr.isValid`/`ssrfIpClassifier` see a hostname needing DNS resolution
    // instead of the literal it is, and would leak literal brackets into the TLS `servername`.
    const hostname = stripIPv6Brackets(url.hostname)
    const vettedIps = (await ldapHostGuard.resolveVettedIps({ host: hostname })).slice(0, MAX_VETTED_IPS_PER_ATTEMPT)

    if (!config.tlsVerify) {
        // Silently accepting whatever certificate (or none) the directory presents is a real,
        // if sometimes deliberate, weakening of the channel — this makes it visible in the logs
        // every time it is exercised, not only at config-save time.
        system.globalLogger().warn({ url: config.url }, '[ldapClient#connect] tlsVerify is disabled — the directory\'s certificate will not be validated')
    }

    // Node's `tls.connect` warns (DEP0123) and ignores `servername` outright when it is an IP
    // address — RFC 6066 §3 restricts SNI to hostnames. That only ever matters for the *configured*
    // host: when it is itself an IP literal (no DNS name to preserve), there is nothing to put in
    // `servername` in the first place, so it is omitted rather than set to the same IP being dialed.
    const tlsOptions: tls.ConnectionOptions = {
        ...(ipaddr.isValid(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: config.tlsVerify,
        ...(isNil(config.caCertificatePem) ? {} : { ca: [config.caCertificatePem] }),
    }

    let lastError: unknown
    for (const ip of vettedIps) {
        const dialUrl = new URL(config.url)
        dialUrl.hostname = ip.includes(':') ? `[${ip}]` : ip
        const client = new Client({
            url: dialUrl.toString(),
            connectTimeout: LDAP_OPERATION_TIMEOUT_MS,
            timeout: LDAP_OPERATION_TIMEOUT_MS,
            ...(config.tlsMode === LdapTlsMode.LDAPS ? { tlsOptions } : {}),
        })
        try {
            if (config.tlsMode === LdapTlsMode.STARTTLS) {
                await withStartTlsTimeout({ client, tlsOptions })
            }
            else {
                // `Client` only opens the socket lazily, on its first operation — an unauthenticated
                // bind (RFC 4513 §5.1.2) forces that now, using a hardcoded empty DN/password (never
                // the caller's own credentials), purely to prove the TCP+TLS handshake this IP
                // completed. Whether the directory then accepts or refuses an anonymous bind is
                // itself a protocol response (a `ResultCodeError`), which proves connectivity either
                // way; only a transport/TLS failure means this IP did not work.
                await probeAnonymousBind(client)
            }
            return client
        }
        catch (error) {
            lastError = error
            await client.unbind().catch(() => undefined)
        }
    }
    throw new LdapStageError({
        stage: LdapTestStage.CONNECT,
        message: `Could not establish a connection to "${hostname}": ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    })
}

// `ldapts`' own `startTLS()` places no deadline on the TLS upgrade: it awaits `tls.connect`'s
// `secureConnect`/`error` events with nothing racing them, so a server that accepts the StartTLS
// extended request and then never completes the handshake hangs this call forever. `ldapts`
// exposes no way to reach the in-flight secure socket from the outside, and no timeout hook on
// `startTLS` itself — `unbind()` is the one public method that unconditionally destroys whatever
// socket the client currently holds (`_destroySocket` runs in its `finally` no matter what),
// which during a stalled handshake is still the original, pre-upgrade plain socket (`startTLS()`
// only reassigns the client's socket once the upgrade resolves). Not awaited: a stalled handshake
// already broke this client's own data listener, so `unbind()`'s own reply wait can itself take up
// to `LDAP_OPERATION_TIMEOUT_MS` to give up — this function must not block that long to report the
// timeout it already detected.
async function withStartTlsTimeout({ client, tlsOptions }: WithStartTlsTimeoutParams): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            client.unbind().catch(() => undefined)
            reject(new LdapStageError({
                stage: LdapTestStage.CONNECT,
                message: `The StartTLS handshake did not complete within ${LDAP_OPERATION_TIMEOUT_MS}ms`,
            }))
        }, LDAP_OPERATION_TIMEOUT_MS)
    })
    try {
        await Promise.race([client.startTLS(tlsOptions), timeout])
    }
    finally {
        clearTimeout(timer)
    }
}

function stripIPv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

async function probeAnonymousBind(client: Client): Promise<void> {
    try {
        await client.bind('', '')
    }
    catch (error) {
        if (error instanceof ResultCodeError) {
            return
        }
        throw error
    }
}

// `ldapts` computes whether a `Client` is "secure" once, at construction, from the original URL
// scheme and whatever `tlsOptions` were passed in — for a StartTLS client that is `false` forever,
// because we deliberately do not pass `tlsOptions` to the constructor (that would make the
// *initial* dial a raw TLS connection, defeating the plaintext-then-upgrade handshake StartTLS
// is). Every public operation calls a private `_ensureConnected()` first, which reconnects
// unconditionally whenever the socket is not currently connected — with no way for a caller to
// tell it "fail instead". So if the upgraded connection ever drops mid-session, the *next*
// `bind`/`search` on this same client would silently re-dial in plaintext. `client.isConnected` is
// the one public signal available for this: refusing here, before that reconnect can happen, is
// the only guard `ldapts`' public API allows.
function assertConnectionStillUpgraded({ client, tlsMode }: AssertConnectionStillUpgradedParams): void {
    if (tlsMode === LdapTlsMode.STARTTLS && !client.isConnected) {
        throw new LdapStageError({
            stage: LdapTestStage.CONNECT,
            message: 'The StartTLS-upgraded connection was lost; refusing to let it silently reconnect in plaintext',
        })
    }
}

async function serviceBind({ client, bindDn, bindPassword, tlsMode }: ServiceBindParams): Promise<void> {
    assertConnectionStillUpgraded({ client, tlsMode })
    try {
        await client.bind(bindDn, bindPassword)
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.SERVICE_BIND, error, fallbackMessage: 'The configured bind account was rejected by the directory' })
    }
}

async function searchForUser({ client, baseDn, userFilter, username, attributeMap, tlsMode }: SearchForUserParams): Promise<Entry> {
    assertConnectionStillUpgraded({ client, tlsMode })
    const filter = ldapFilterUtils.buildUserSearchFilter({ userFilter, username })
    // `memberOf` is read unconditionally, alongside the identity attributes — it costs nothing extra
    // (one more attribute on the same search) and is the direct-membership source group mapping
    // (Phase 2) needs on every sign-in, not only when nested-group search is configured.
    const attributes = unique([attributeMap.email, attributeMap.firstName, attributeMap.lastName, attributeMap.subject, 'memberOf'])
    const explicitBufferAttributes = attributeMap.subject === 'objectGUID' ? ['objectGUID'] : []

    let result
    try {
        // `sizeLimit: 2` is deliberate: one match is a normal result and any count above it is a
        // filter or directory-shape problem the caller must refuse rather than pick a winner from
        // — the exact count matters here, so the request asks for one more than "exactly one" can
        // ever need. Search references (RFC 4511 §4.5.3) are never followed: this reads only
        // `searchEntries`, so a referral response is invisible rather than chased.
        result = await client.search(baseDn, {
            scope: 'sub',
            filter,
            attributes,
            explicitBufferAttributes,
            sizeLimit: 2,
            timeLimit: LDAP_OPERATION_TIMEOUT_MS / 1000,
        })
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.SEARCH, error, fallbackMessage: 'The directory search failed' })
    }

    if (result.searchEntries.length === 0) {
        throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'No matching entry was found', notFound: true })
    }
    if (result.searchEntries.length > 1) {
        throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'The filter matched more than one entry' })
    }
    return result.searchEntries[0]
}

// Nested-group resolution (Phase 2): AD's own transitive-membership filter, templated with the
// signed-in user's own DN (never the caller-supplied username — the DN just came back from
// `searchForUser` on the very same connection, so it needs no further escaping concerns of its
// own beyond the same RFC 4515 value-escaping every filter value gets). No `sizeLimit` — an
// arbitrary number of nested groups is a normal, expected result here, unlike the user search's
// deliberately-narrow "exactly one" contract.
async function searchNestedGroups({ client, groupSearchBaseDn, groupSearchFilter, userDn, tlsMode }: SearchNestedGroupsParams): Promise<string[]> {
    assertConnectionStillUpgraded({ client, tlsMode })
    const filter = ldapFilterUtils.buildFilterFromTemplate({ template: groupSearchFilter, placeholder: '{userDn}', value: userDn })
    let result
    try {
        result = await client.search(groupSearchBaseDn, {
            scope: 'sub',
            filter,
            attributes: ['dn'],
            timeLimit: LDAP_OPERATION_TIMEOUT_MS / 1000,
        })
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.SEARCH, error, fallbackMessage: 'The nested-group search failed' })
    }
    return result.searchEntries.map((entry) => entry.dn)
}

// Group resolution (Phase 2), shared by sign-in and reconcile: direct `memberOf` values on the
// already-fetched entry, plus (when configured) the nested-group search — `unique` because AD's
// transitive-membership search can re-report a group the entry's own `memberOf` already named.
async function resolveMemberGroupDns({ client, entry, config, tlsMode }: ResolveMemberGroupDnsParams): Promise<string[]> {
    const directGroupDns = ldapAttributeUtils.readMultiValueAttribute({ entry, name: 'memberOf' })
    if (!config.nestedGroups || isNil(config.groupSearchBaseDn) || isNil(config.groupSearchFilter)) {
        return directGroupDns
    }
    const nestedGroupDns = await searchNestedGroups({
        client,
        groupSearchBaseDn: config.groupSearchBaseDn,
        groupSearchFilter: config.groupSearchFilter,
        userDn: entry.dn,
        tlsMode,
    })
    return unique([...directGroupDns, ...nestedGroupDns])
}

// Reconcile's own lookup (Phase 2): finds the directory entry an existing `user_federated_identity`
// row points at, by its own stable subject, rather than by the (mutable) email/username a sign-in
// searches on. `objectGUID` cannot be searched as a string — AD compares it as a raw octet string,
// so the canonical dashed form this same client produced via `ldapAttributeUtils
// .objectGuidBufferToCanonicalString` has to be turned back into the `\xx\xx...` escaped-octet
// filter syntax RFC 4515 §3 uses for binary values.
async function searchBySubject({ client, baseDn, attributeMap, subject, tlsMode }: SearchBySubjectParams): Promise<Entry | null> {
    assertConnectionStillUpgraded({ client, tlsMode })
    const filterValue = attributeMap.subject === 'objectGUID' ? canonicalGuidToFilterValue(subject) : ldapFilterUtils.escapeFilterValue(subject)
    const filter = `(${attributeMap.subject}=${filterValue})`
    const attributes = unique([attributeMap.email, attributeMap.firstName, attributeMap.lastName, attributeMap.subject, 'memberOf', 'userAccountControl'])
    const explicitBufferAttributes = attributeMap.subject === 'objectGUID' ? ['objectGUID'] : []

    let result
    try {
        result = await client.search(baseDn, {
            scope: 'sub',
            filter,
            attributes,
            explicitBufferAttributes,
            sizeLimit: 2,
            timeLimit: LDAP_OPERATION_TIMEOUT_MS / 1000,
        })
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.SEARCH, error, fallbackMessage: 'The directory search failed' })
    }
    if (result.searchEntries.length === 0) {
        return null
    }
    if (result.searchEntries.length > 1) {
        throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'The subject filter matched more than one entry' })
    }
    return result.searchEntries[0]
}

// The inverse of `objectGuidBufferToCanonicalString`: re-groups the canonical
// `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` string back into the mixed-endian 16-byte wire form (the
// first three groups little-endian, the last two big-endian — the same asymmetry AD's own GUID
// APIs use), then RFC 4515 §3 octet-escapes every byte (`\xx`) — the syntax the grammar requires
// for a binary attribute value in a filter.
// `subject` is our own stored value, never attacker-supplied at this call site directly — but it
// is still read back out of the database, and a malformed value here (a bad migration, a
// hand-edited row, a bug in whatever produced it) must not silently build a wrong-shaped filter
// fragment. Guarding the exact shape `objectGuidBufferToCanonicalString` always produces closes
// that off as defense in depth, the same way `LdapStageError` from a search or bind failure
// already does for every other stage.
const CANONICAL_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function canonicalGuidToFilterValue(canonical: string): string {
    if (!CANONICAL_GUID_PATTERN.test(canonical)) {
        throw new LdapStageError({
            stage: LdapTestStage.SEARCH,
            message: 'Stored subject is not a canonical objectGUID string',
        })
    }
    const [group1, group2, group3, group4, group5] = canonical.split('-')
    const reordered = ldapAttributeUtils.swapByteOrder(group1) + ldapAttributeUtils.swapByteOrder(group2) + ldapAttributeUtils.swapByteOrder(group3) + group4 + group5
    return reordered.match(/.{2}/g)?.map((byte) => `\\${byte}`).join('') ?? ''
}

// Always binds on a brand-new connection rather than reusing the service-bind connection — RFC
// 4513 §5.1.2's rebind-in-place would mean falling back to the service account's own authorization
// on a failed user bind, which is exactly the ambiguity a "new connection per bind" design avoids.
// The slot for this connection is held for its whole lifetime (connect through unbind) — the same
// concurrency guarantee `lookupDirectoryUser`'s and `/test`'s own connections hold for themselves.
async function bindAsUser({ config, userDn, password }: BindAsUserParams): Promise<void> {
    await withConnectionSlot(async () => {
        const client = await connect({ config })
        try {
            assertConnectionStillUpgraded({ client, tlsMode: config.tlsMode })
            await client.bind(userDn, password)
        }
        catch (error) {
            throw toStageError({ stage: LdapTestStage.USER_BIND, error, fallbackMessage: 'Invalid credentials' })
        }
        finally {
            await client.unbind().catch(() => undefined)
        }
    })
}

// A `ResultCodeError` is the directory answering the specific operation, so it is trusted as that
// stage's own failure. Anything else (a dropped socket, a mid-operation TLS reset) means the
// channel `connect()` had just proven healthy stopped being healthy, which is a connectivity
// failure wearing a later stage's name — reclassified so the caller (and `/test`'s response) blame
// the transport rather than, say, the bind account.
function toStageError({ stage, error, fallbackMessage }: ToStageErrorParams): LdapStageError {
    if (error instanceof ResultCodeError) {
        return new LdapStageError({ stage, message: error.message, ldapResultCode: error.code })
    }
    if (error instanceof LdapStageError) {
        return error
    }
    return new LdapStageError({
        stage: LdapTestStage.CONNECT,
        message: error instanceof Error ? error.message : fallbackMessage,
    })
}

export type ResolvedLdapConnectionConfig = {
    url: string
    tlsMode: LdapTlsMode
    tlsVerify: boolean
    caCertificatePem?: string
}

type ConnectParams = {
    config: ResolvedLdapConnectionConfig
}

type WithStartTlsTimeoutParams = {
    client: Client
    tlsOptions: tls.ConnectionOptions
}

type AssertConnectionStillUpgradedParams = {
    client: Client
    tlsMode: LdapTlsMode
}

type ServiceBindParams = {
    client: Client
    bindDn: string
    bindPassword: string
    tlsMode: LdapTlsMode
}

type SearchForUserParams = {
    client: Client
    baseDn: string
    userFilter: string
    username: string
    attributeMap: LdapAttributeMap
    tlsMode: LdapTlsMode
}

type SearchNestedGroupsParams = {
    client: Client
    groupSearchBaseDn: string
    groupSearchFilter: string
    userDn: string
    tlsMode: LdapTlsMode
}

type SearchBySubjectParams = {
    client: Client
    baseDn: string
    attributeMap: LdapAttributeMap
    subject: string
    tlsMode: LdapTlsMode
}

type ResolveMemberGroupDnsParams = {
    client: Client
    entry: Entry
    config: Pick<LdapConfig, 'nestedGroups' | 'groupSearchBaseDn' | 'groupSearchFilter'>
    tlsMode: LdapTlsMode
}

type BindAsUserParams = {
    config: ResolvedLdapConnectionConfig
    userDn: string
    password: string
}

type ToStageErrorParams = {
    stage: LdapTestStage
    error: unknown
    fallbackMessage: string
}
