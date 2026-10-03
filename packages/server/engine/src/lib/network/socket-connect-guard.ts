import { isIP, Socket } from 'node:net'
import { SSRFBlockedError, ssrfIpClassifier } from '@aiqadam/shared'
import type { GuardPolicy, UninstallFn } from './ssrf-guard'

export function installSocketConnectGuard(policy: GuardPolicy): UninstallFn {
    const originalConnect = Socket.prototype.connect
    Socket.prototype.connect = function guardedConnect(this: Socket, ...args: unknown[]): Socket {
        const decision = decideConnect({ args, policy })
        if (decision.kind === 'block') {
            failConnect({ socket: this, error: decision.error })
            return this
        }
        // Node is handed the plain-data snapshot that was inspected, never the caller's object,
        // re-packed as a plain (options[, cb]) call. Each target value is read once, so the check
        // and the connect see the same value whichever argument shape the caller used.
        Reflect.apply(originalConnect, this, [decision.options, ...decision.callbackArgs])
        return this
    }
    return () => {
        Socket.prototype.connect = originalConnect
    }
}

function decideConnect({ args, policy }: DecideConnectParams): ConnectDecision {
    const normalized = normalizeConnectArgs(args)
    if (!normalized) return block({ host: UNPARSED, ip: UNPARSED })
    const { options, callbackArgs } = normalized

    // An IPC/unix-socket path never reaches the network stack, and Node ignores host/port once a
    // path is set.
    if (options.path) return { kind: 'allow', options, callbackArgs }

    const rawHost = options.host
    if (rawHost && typeof rawHost !== 'string') return block({ host: UNPARSED, ip: UNPARSED })
    // Same default Node applies: an empty or absent host connects to 'localhost'.
    const host = typeof rawHost === 'string' && rawHost.length > 0 ? rawHost : 'localhost'
    const port = readPort(options.port)

    // Node skips the resolver entirely for an IP literal, so this is the only check it gets.
    if (isIP(host) !== 0) {
        return isBlockedAddress({ ip: host, port, policy })
            ? block({ host, ip: host })
            : { kind: 'allow', options, callbackArgs }
    }

    const { lookup } = options
    // Without a caller-supplied resolver Node uses dns.lookup, which the DNS guard already checks.
    if (lookup === undefined || lookup === null) return { kind: 'allow', options, callbackArgs }
    if (typeof lookup !== 'function') return block({ host, ip: UNPARSED })
    // A caller-supplied resolver never passes through the DNS guard, so its answers are checked here.
    // `options` is already a plain-data snapshot, so copying it re-runs no caller getter.
    const resolve = (lookupArgs: unknown[]): void => {
        Reflect.apply(lookup, undefined, lookupArgs)
    }
    const guardedOptions = { ...options, lookup: guardLookup({ resolve, port, policy }) }
    return { kind: 'allow', options: guardedOptions, callbackArgs }
}

// Mirrors Node's internal normalizeArgs, which is how Socket#connect itself reads its arguments.
// net.connect / net.createConnection, and so the http agents, undici and fetch built on them, hand
// Socket#connect the already-normalized [options, cb] tuple as one array argument. Any shape
// outside the ones Node accepts yields undefined so the guard fails closed. Caller options are
// copied once into a plain snapshot, which is both what gets inspected and what Node receives.
function normalizeConnectArgs(args: unknown[]): NormalizedConnect | undefined {
    const first = args[0]
    if (Array.isArray(first)) {
        const tuple: unknown[] = first
        if (args.length !== 1 || tuple.length === 0 || tuple.length > 2) return undefined
        const [options, callback] = tuple
        if (!isConnectOptions(options)) return undefined
        if (callback !== undefined && callback !== null && typeof callback !== 'function') return undefined
        return { options: snapshotOptions(options), callbackArgs: toCallbackArgs(callback) }
    }
    if (args.length === 0) return { options: {}, callbackArgs: [] }
    const callbackArgs = toCallbackArgs(args[args.length - 1])
    if (typeof first === 'object' && first !== null) {
        return isConnectOptions(first) ? { options: snapshotOptions(first), callbackArgs } : undefined
    }
    if (isPipeName(first)) return { options: { path: first }, callbackArgs }
    const host = args.length > 1 && typeof args[1] === 'string' ? args[1] : undefined
    return { options: host === undefined ? { port: first } : { port: first, host }, callbackArgs }
}

// Node reads the target keys with a plain property lookup, so an inherited or non-enumerable value
// is the one it would connect to. Each target key is read exactly once, and only a defined value is
// kept, which Node treats the same as an absent key. Every other own enumerable key is copied the
// way object spread copies it.
function snapshotOptions(source: ConnectOptions): ConnectOptions {
    const rest = Object.fromEntries(Reflect.ownKeys(source)
        .filter((key) => !TARGET_KEYS.includes(key) && Object.prototype.propertyIsEnumerable.call(source, key))
        .map((key) => [key, source[key]]))
    const targets = Object.fromEntries(TARGET_KEYS
        .map((key) => [key, source[key]])
        .filter(([, value]) => value !== undefined))
    return { ...rest, ...targets }
}

function guardLookup({ resolve, port, policy }: GuardLookupParams): GuardedLookup {
    return function guardedLookup(hostname: unknown, lookupOptions: unknown, callback: unknown): void {
        if (typeof callback !== 'function') {
            throw new TypeError('lookup callback must be a function')
        }
        resolve([hostname, lookupOptions, (err: unknown, address: unknown, family: unknown): void => {
            if (err) {
                Reflect.apply(callback, undefined, [err, address, family])
                return
            }
            // The answer is read once into plain data, and that copy is both what gets checked and
            // what Node connects to.
            const answer = snapshotResolvedAnswer(address)
            const blockedIp = answer === undefined ? UNPARSED : findBlockedResolvedAddress({ answer, port, policy })
            if (blockedIp !== undefined) {
                const error = new SSRFBlockedError({ host: String(hostname), ip: blockedIp })
                Reflect.apply(callback, undefined, [error, '', 0])
                return
            }
            Reflect.apply(callback, undefined, [null, answer, family])
        }])
    }
}

// Covers both answer shapes Node asks a resolver for: a single address, and the `all: true` list
// used by autoSelectFamily. An answer in neither shape, or a list entry without a string address,
// yields undefined so it counts as blocked.
function snapshotResolvedAnswer(address: unknown): ResolvedAnswer | undefined {
    if (typeof address === 'string') return address
    if (!Array.isArray(address)) return undefined
    const entries = Array.from(address, snapshotResolvedEntry)
    return entries.every((entry): entry is ResolvedEntry => entry !== undefined) ? entries : undefined
}

// Node reads only `address` and `family` from an entry, so those are the two values copied.
function snapshotResolvedEntry(entry: unknown): ResolvedEntry | undefined {
    if (typeof entry !== 'object' || entry === null) return undefined
    const address = 'address' in entry ? entry.address : undefined
    if (typeof address !== 'string') return undefined
    return { address, family: 'family' in entry ? entry.family : undefined }
}

function findBlockedResolvedAddress({ answer, port, policy }: FindBlockedResolvedAddressParams): string | undefined {
    const ips = typeof answer === 'string' ? [answer] : answer.map((entry) => entry.address)
    return ips.find((ip) => isBlockedAddress({ ip, port, policy }))
}

function isBlockedAddress({ ip, port, policy }: IsBlockedAddressParams): boolean {
    if (!ssrfIpClassifier.isBlockedIp({ ip, allowList: policy.allowList })) return false
    return !isExemptLoopbackPort({ host: ip, port, policy })
}

function isExemptLoopbackPort({ host, port, policy }: IsExemptLoopbackPortParams): boolean {
    if (!LOOPBACK_IPS.has(host) || port === undefined) return false
    return policy.allowedLoopbackPorts.has(port)
}

// Node coerces a validated port with `port |= 0`, so the numeric string a URL parser yields is the
// same port as the number. Anything else earns no loopback exemption.
function readPort(port: unknown): number | undefined {
    if (typeof port === 'number') return Number.isInteger(port) ? port : undefined
    if (typeof port !== 'string' || port.trim().length === 0) return undefined
    const parsed = Number(port)
    return Number.isInteger(parsed) ? parsed : undefined
}

// Node's isPipeName: a string that does not parse as a non-negative number is an IPC path.
function isPipeName(value: unknown): value is string {
    if (typeof value !== 'string') return false
    return !(Number(value) >= 0)
}

function isConnectOptions(value: unknown): value is ConnectOptions {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The callback is forwarded as the very same function: Node binds it to the socket, and tls relies
// on that `this`.
function toCallbackArgs(value: unknown): unknown[] {
    return typeof value === 'function' ? [value] : []
}

// Same timing as Node's own connect failures (connectErrorNT): the error reaches the socket on a
// later tick, once callers that attach their listeners after connect() returns are listening.
// http's ClientRequest is one, and a synchronous destroy reaches it as an uncaught exception.
function failConnect({ socket, error }: FailConnectParams): void {
    process.nextTick(() => socket.destroy(error))
}

function block({ host, ip }: BlockParams): ConnectDecision {
    return { kind: 'block', error: new SSRFBlockedError({ host, ip }) }
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1'])
const UNPARSED = 'unparsed connect target'
const TARGET_KEYS: readonly PropertyKey[] = ['host', 'port', 'path', 'lookup']

type GuardedLookup = (hostname: unknown, lookupOptions: unknown, callback: unknown) => void

type ConnectOptions = {
    [key: string]: unknown
    [key: symbol]: unknown
    path?: unknown
    host?: unknown
    port?: unknown
    lookup?: unknown
}

type NormalizedConnect = {
    options: ConnectOptions
    callbackArgs: unknown[]
}

type ConnectDecision =
    | { kind: 'allow', options: ConnectOptions, callbackArgs: unknown[] }
    | { kind: 'block', error: SSRFBlockedError }

type DecideConnectParams = {
    args: unknown[]
    policy: GuardPolicy
}

type GuardLookupParams = {
    resolve: (lookupArgs: unknown[]) => void
    port: number | undefined
    policy: GuardPolicy
}

type ResolvedEntry = {
    address: string
    family: unknown
}

type ResolvedAnswer = string | ResolvedEntry[]

type FindBlockedResolvedAddressParams = {
    answer: ResolvedAnswer
    port: number | undefined
    policy: GuardPolicy
}

type IsBlockedAddressParams = {
    ip: string
    port: number | undefined
    policy: GuardPolicy
}

type IsExemptLoopbackPortParams = {
    host: string
    port: number | undefined
    policy: GuardPolicy
}

type BlockParams = {
    host: string
    ip: string
}

type FailConnectParams = {
    socket: Socket
    error: SSRFBlockedError
}
