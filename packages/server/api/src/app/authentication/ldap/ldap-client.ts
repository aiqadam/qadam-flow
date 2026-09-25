import { isNil, LdapAttributeMap, LdapTestStage, LdapTlsMode } from '@aiqadam/shared'
import { Client, Entry, ResultCodeError } from 'ldapts'
import { ldapFilterUtils } from './ldap-filter'
import { ldapHostGuard } from './ldap-host-guard'
import { LdapStageError } from './ldap-stage-error'

// RFC 4511/4513 give a directory server 5s of goodwill for any single operation before the caller
// is entitled to conclude it is unreachable, and a sign-in request holding a connection open
// indefinitely is itself an availability risk. All operations below share this one bound rather
// than each picking their own.
const LDAP_OPERATION_TIMEOUT_MS = 5000

// A single admin `/test` click, or a burst of concurrent sign-ins, must not be able to open an
// unbounded number of sockets to the directory. This throttles connection attempts process-wide;
// a request past the cap waits for a free slot rather than failing outright, and the wait is
// bounded by the 5s operation timeout on whichever connection is ahead of it in the queue.
const MAX_CONCURRENT_LDAP_CONNECTIONS = 10
let activeConnections = 0
const connectionWaiters: Array<() => void> = []

async function acquireConnectionSlot(): Promise<void> {
    if (activeConnections < MAX_CONCURRENT_LDAP_CONNECTIONS) {
        activeConnections += 1
        return
    }
    await new Promise<void>((resolve) => connectionWaiters.push(resolve))
    activeConnections += 1
}

function releaseConnectionSlot(): void {
    activeConnections -= 1
    const next = connectionWaiters.shift()
    if (!isNil(next)) {
        next()
    }
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

// Connects to the first vetted IP that accepts a TCP/TLS handshake, presenting the *hostname* as
// the TLS `servername` even though the socket dials the IP literal — ldapts never derives
// `servername` on our behalf. For `ldaps://`, `_connect()` calls `tls.connect(port, host,
// tlsOptions)`, and Node only defaults `servername` to that `host` argument when it is not itself
// an IP literal — which it is here, since we dial the vetted IP directly — so an explicit
// `tlsOptions.servername` is the only thing standing between this connection and either silently
// skipped SNI or a certificate check against the IP instead of the configured hostname. For
// `startTLS()`, there is no default at all: the upgrade runs the caller-supplied options straight
// through `tls.connect` over an already-open plain socket, which carries no host of its own.
async function connect({ config }: ConnectParams): Promise<Client> {
    const url = new URL(config.url)
    const hostname = url.hostname
    const vettedIps = await ldapHostGuard.resolveVettedIps({ host: hostname })

    const tlsOptions = {
        servername: hostname,
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
                await client.startTLS(tlsOptions)
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

async function serviceBind({ client, bindDn, bindPassword }: ServiceBindParams): Promise<void> {
    try {
        await client.bind(bindDn, bindPassword)
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.SERVICE_BIND, error, fallbackMessage: 'The configured bind account was rejected by the directory' })
    }
}

async function searchForUser({ client, baseDn, userFilter, username, attributeMap }: SearchForUserParams): Promise<Entry> {
    const filter = ldapFilterUtils.buildUserSearchFilter({ userFilter, username })
    const attributes = unique([attributeMap.email, attributeMap.firstName, attributeMap.lastName, attributeMap.subject])
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
        throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'No matching entry was found' })
    }
    if (result.searchEntries.length > 1) {
        throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'The filter matched more than one entry' })
    }
    return result.searchEntries[0]
}

// Always binds on a brand-new connection rather than reusing the service-bind connection — RFC
// 4513 §5.1.2's rebind-in-place would mean falling back to the service account's own authorization
// on a failed user bind, which is exactly the ambiguity a "new connection per bind" design avoids.
async function bindAsUser({ config, userDn, password }: BindAsUserParams): Promise<void> {
    const client = await withConnectionSlot(() => connect({ config }))
    try {
        await client.bind(userDn, password)
    }
    catch (error) {
        throw toStageError({ stage: LdapTestStage.USER_BIND, error, fallbackMessage: 'Invalid credentials' })
    }
    finally {
        await client.unbind().catch(() => undefined)
    }
}

export const ldapClient = {
    connect,
    serviceBind,
    searchForUser,
    bindAsUser,
    withConnectionSlot,
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

function unique(values: string[]): string[] {
    return Array.from(new Set(values))
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

type ServiceBindParams = {
    client: Client
    bindDn: string
    bindPassword: string
}

type SearchForUserParams = {
    client: Client
    baseDn: string
    userFilter: string
    username: string
    attributeMap: LdapAttributeMap
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
