import { DefaultProjectRole, isNil, LdapGroupMapping, PlatformRole, tryCatchSync } from '@aiqadam/shared'

export const ldapGroupMappingUtils = {
    normalizeGroupDn,
    resolveGrants,
    platformRoleRank,
}

const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
    [PlatformRole.MEMBER]: 0,
    [PlatformRole.OPERATOR]: 1,
    [PlatformRole.ADMIN]: 2,
}

const PROJECT_ROLE_RANK: Record<DefaultProjectRole, number> = {
    [DefaultProjectRole.VIEWER]: 0,
    [DefaultProjectRole.EDITOR]: 1,
    [DefaultProjectRole.ADMIN]: 2,
}

// A DN is compared here as a *structured* value, never flattened back into a single joined string
// before comparison — a joined string cannot tell "one RDN whose value contains a real comma"
// apart from "two separate RDNs", nor "one multi-valued RDN (`+`-joined)" apart from "two
// single-valued RDNs" (`,`-joined), because both cases produce the identical output string once
// everything is glued back together with the same separator. The structure is: an ordered list of
// RDNs (order matters — root-to-leaf), each RDN itself an order-independent (sorted) list of
// `[type, value]` pairs, with `+` (multi-valued RDN) kept structurally distinct from `,` (RDN
// boundary) all the way through. `resolveGrants`'s `Set`/`Map` lookups need a primitive key, not a
// nested structure, so the canonical form this function returns is `JSON.stringify` of that
// structure — still a string, but one whose *shape* fully determines equality, not one built by
// concatenating fields that could have come from a different split.
//
// Further corrections, all defense-in-depth against a spoofed value colliding with a real one:
// - Hex escapes (`\XX`) are decoded as raw bytes accumulated and decoded once as UTF-8 (in `fatal`
//   mode — see `decodeTokens`), not one `String.fromCharCode` per byte — a multi-byte UTF-8
//   character (e.g. `é` as `\C3\A9`) decoded byte-by-byte via `fromCharCode` produces two separate
//   Latin-1 code points (`Ã©`) instead of the one intended character, which is itself a
//   distinct-string mismatch bug, not merely a cosmetic one.
// - Boundary trimming (stripping incidental DN-formatting whitespace like `CN=Admins, DC=Example`)
//   operates on a token list built by the same escape-aware tokeniser used for decoding, and trims
//   only a token that is *itself* an unescaped literal ASCII space — a component that legitimately
//   ends with an *escaped* space (`\ `) is never trimmed, because that token's kind is
//   `escapedChar`, not `literal`, regardless of its position.
// - An attribute-value assertion with no unescaped `=` at all (`parseAva`) and a value in RFC
//   4514's BER-hex form (`normalizeAvaValue`) each get their own sentinel/tag rather than being
//   coerced into the same shape a differently-written, but semantically different, DN would
//   produce.
function normalizeGroupDn(dn: string): string {
    const rdns = splitOnUnescapedChar({ raw: dn, separator: ',' }).map(parseRdn)
    return JSON.stringify(rdns)
}

// Splits on a top-level (unescaped) occurrence of a single separator character, keeping every
// escape sequence (backslash + one char, or a `\XX` hex pair) intact in each returned raw segment —
// decoding happens later, per component, in `normalizeComponent`.
function splitOnUnescapedChar({ raw, separator }: SplitOnUnescapedCharParams): string[] {
    const parts: string[] = []
    let current = ''
    let i = 0
    while (i < raw.length) {
        const char = raw[i]
        if (char === '\\' && i + 1 < raw.length) {
            const escapeLength = isHexEscapeAt({ raw, backslashIndex: i }) ? 3 : 2
            current += raw.slice(i, i + escapeLength)
            i += escapeLength
            continue
        }
        if (char === separator) {
            parts.push(current)
            current = ''
            i += 1
            continue
        }
        current += char
        i += 1
    }
    parts.push(current)
    return parts
}

// Index of the first top-level (unescaped) occurrence of `char` in `raw`, or -1. Used to split an
// attribute-value assertion (`type=value`) on its separating `=` without being confused by an
// escaped one inside the value.
function findFirstUnescapedChar({ raw, char }: FindFirstUnescapedCharParams): number {
    let i = 0
    while (i < raw.length) {
        if (raw[i] === '\\' && i + 1 < raw.length) {
            i += isHexEscapeAt({ raw, backslashIndex: i }) ? 3 : 2
            continue
        }
        if (raw[i] === char) {
            return i
        }
        i += 1
    }
    return -1
}

function isHexEscapeAt({ raw, backslashIndex }: IsHexEscapeAtParams): boolean {
    return /^[0-9a-fA-F]{2}/.test(raw.slice(backslashIndex + 1, backslashIndex + 3))
}

// One RDN is an order-independent set of attribute-value assertions (single-valued RDNs are the
// common case of a one-element set); `+`-joined AVAs within it are sorted so that `a=1+b=2` and
// `b=2+a=1` — the same multi-valued RDN, written in a different order — normalize identically,
// without ever merging the `+` boundary into the same separator `,` uses between RDNs.
function parseRdn(rawRdn: string): [string, string][] {
    return splitOnUnescapedChar({ raw: rawRdn, separator: '+' })
        .map(parseAva)
        .sort(([typeA, valueA], [typeB, valueB]) => {
            const keyA = `${typeA}=${valueA}`
            const keyB = `${typeB}=${valueB}`
            if (keyA < keyB) return -1
            if (keyA > keyB) return 1
            return 0
        })
}

function parseAva(rawAva: string): [string, string] {
    const equalsIndex = findFirstUnescapedChar({ raw: rawAva, char: '=' })
    if (equalsIndex === -1) {
        // No unescaped `=` at all means this is not a valid attribute-value assertion per RFC
        // 4514 — coercing it into `[wholeString, '']` would make the invalid `cn` and the valid,
        // empty-valued `cn=` normalize identically (`cn=,dc=x` vs `cn,dc=x` colliding). The
        // sentinel folds the raw text back in, so two different invalid AVAs can still only ever
        // collide with each other when byte-for-byte identical, and never with a valid AVA at all
        // — no real attribute type can contain a NUL.
        return [`\u0000invalid-ava\u0000${rawAva}`, rawAva]
    }
    const rawType = rawAva.slice(0, equalsIndex)
    const rawValue = rawAva.slice(equalsIndex + 1)
    return [normalizeComponent(rawType), normalizeAvaValue(rawValue)]
}

// RFC 4514's `#<hex>` form (an unescaped leading `#`) is a BER-encoded attribute value, not the
// literal text "#<hex>" — actually decoding the BER (a meaningful amount of ASN.1 machinery for a
// path directory administrators are not expected to exercise for a role-granting group) is more
// than this comparison needs; instead the value is tagged so it can never normalize the same way
// an escaped `\#<hex>` (the literal string starting with a hash character) does, closing the
// collision without needing to understand the BER content itself. A `#` that isn't the value's
// very first raw character — escaped or not — is always just a literal character, per the same
// grammar, so only this leading, unescaped case needs the special path.
function normalizeAvaValue(rawValue: string): string {
    if (rawValue.startsWith('#')) {
        return `#ber:${lowercaseAsciiOnly(rawValue.slice(1))}`
    }
    return normalizeComponent(rawValue)
}

// Tokenises a raw (still-escaped) component into a sequence of literal characters, plain
// backslash-escapes, and hex-escaped bytes — the unit both boundary-trimming and decoding operate
// on, so trimming can tell a literal space apart from an escaped one and decoding can tell a run of
// `\XX` bytes apart from a literal character that happens to look the same once resolved.
function tokenizeComponent(raw: string): RawToken[] {
    const tokens: RawToken[] = []
    let i = 0
    while (i < raw.length) {
        const char = raw[i]
        if (char === '\\' && i + 1 < raw.length) {
            if (isHexEscapeAt({ raw, backslashIndex: i })) {
                tokens.push({ kind: 'escapedHexByte', byte: parseInt(raw.slice(i + 1, i + 3), 16) })
                i += 3
                continue
            }
            tokens.push({ kind: 'escapedChar', char: raw[i + 1] })
            i += 2
            continue
        }
        tokens.push({ kind: 'literal', char })
        i += 1
    }
    return tokens
}

// Strips only a leading/trailing token that is itself an *unescaped* literal ASCII space (0x20) —
// never an escaped one (`escapedChar`/`escapedHexByte`), so a component that legitimately starts or
// ends with an escaped space (`\ Admins`, `Admins\ `) is never confused with incidental
// DN-formatting whitespace and stripped by mistake.
function trimLiteralAsciiSpaceTokens(tokens: RawToken[]): RawToken[] {
    let start = 0
    let end = tokens.length
    while (start < end && isLiteralAsciiSpace(tokens[start])) {
        start += 1
    }
    while (end > start && isLiteralAsciiSpace(tokens[end - 1])) {
        end -= 1
    }
    return tokens.slice(start, end)
}

function isLiteralAsciiSpace(token: RawToken): boolean {
    return token.kind === 'literal' && token.char === ' '
}

// Resolves the token list to its final string: a run of one or more consecutive `escapedHexByte`
// tokens is decoded once, as UTF-8, from the accumulated raw bytes — never one
// `String.fromCharCode` per byte, which would silently misdecode any multi-byte UTF-8 character
// (see the design comment on `normalizeGroupDn`). The decoder runs in `fatal` mode: a byte
// sequence a real UTF-8 producer could never have written (as opposed to `Buffer#toString('utf8')`,
// which silently substitutes U+FFFD for it) instead makes the *whole* component the sentinel below
// — an invalid escape must make the DN fail to match anything, never quietly compare equal to
// whatever `�` happened to also come from. Every other token contributes its own resolved
// character directly.
const INVALID_UTF8_ESCAPE_SENTINEL = '\u0000invalid-utf8-escape\u0000'

function decodeTokens(tokens: RawToken[]): string {
    let result = ''
    let hexRun: number[] = []
    let sawInvalidUtf8 = false
    const flushHexRun = (): void => {
        if (hexRun.length === 0) {
            return
        }
        const { data, error } = tryCatchSync(() => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hexRun)))
        if (!isNil(error) || isNil(data)) {
            sawInvalidUtf8 = true
        }
        else {
            result += data
        }
        hexRun = []
    }
    for (const token of tokens) {
        if (token.kind === 'escapedHexByte') {
            hexRun.push(token.byte)
            continue
        }
        flushHexRun()
        result += token.char
    }
    flushHexRun()
    return sawInvalidUtf8 ? INVALID_UTF8_ESCAPE_SENTINEL : result
}

function normalizeComponent(raw: string): string {
    const trimmed = trimLiteralAsciiSpaceTokens(tokenizeComponent(raw))
    return lowercaseAsciiOnly(decodeTokens(trimmed))
}

const ASCII_UPPER_A = 0x41
const ASCII_UPPER_Z = 0x5a
const ASCII_CASE_OFFSET = 0x20

// Deliberately ASCII-only — `String#toLowerCase()`'s full Unicode case folding is exactly the
// homoglyph hole this function exists to close (e.g. U+212A KELVIN SIGN folding onto ASCII `k`, or
// Turkish dotless `ı`/dotted `İ` folding across the ASCII `i`/`I` pair under some locales): never
// touching a non-ASCII codepoint means a lookalike can never fold onto — or away from — a real
// ASCII letter.
function lowercaseAsciiOnly(value: string): string {
    return Array.from(value).map((char) => {
        const codePoint = char.codePointAt(0) ?? 0
        if (codePoint >= ASCII_UPPER_A && codePoint <= ASCII_UPPER_Z) {
            return String.fromCodePoint(codePoint + ASCII_CASE_OFFSET)
        }
        return char
    }).join('')
}

// The platform role is the *highest* matched mapping's role (never lower than what a lower-ranked
// matching group would grant); a project's role is likewise the highest among every matching
// mapping that names that project. A mapping with no `platformRole` at all contributes nothing to
// the platform-role decision — "no mapping sets a platform role" (distinct from "every mapping
// grants MEMBER") is exactly what leaves the caller's existing platform role untouched.
function resolveGrants({ groupMappings, memberGroupDns }: ResolveGrantsParams): ResolvedGrants {
    const normalizedMemberDns = new Set(memberGroupDns.map(normalizeGroupDn))
    const matchedMappings = groupMappings.filter((mapping) => normalizedMemberDns.has(normalizeGroupDn(mapping.groupDn)))

    const platformRole = matchedMappings.reduce<PlatformRole | null>((highest, mapping) => {
        if (isNil(mapping.platformRole)) {
            return highest
        }
        if (isNil(highest) || PLATFORM_ROLE_RANK[mapping.platformRole] > PLATFORM_ROLE_RANK[highest]) {
            return mapping.platformRole
        }
        return highest
    }, null)

    const projectRoles = new Map<string, DefaultProjectRole>()
    for (const mapping of matchedMappings) {
        for (const project of mapping.projects) {
            const existing = projectRoles.get(project.projectId)
            if (isNil(existing) || PROJECT_ROLE_RANK[project.role] > PROJECT_ROLE_RANK[existing]) {
                projectRoles.set(project.projectId, project.role)
            }
        }
    }

    return { platformRole, projectRoles }
}

// Exposed so `ldap-group-mapping-service.ts` can decide whether a mapped role *raises* a
// MANUAL role (allowed — and the point at which provenance flips to LDAP) or would *lower* one
// (never allowed — see the round-3 fix on `applyPlatformRoleGrant`'s own comment) without
// duplicating the rank table.
function platformRoleRank(role: PlatformRole): number {
    return PLATFORM_ROLE_RANK[role]
}

type SplitOnUnescapedCharParams = {
    raw: string
    separator: string
}

type FindFirstUnescapedCharParams = {
    raw: string
    char: string
}

type IsHexEscapeAtParams = {
    raw: string
    backslashIndex: number
}

type RawToken =
    | { kind: 'literal', char: string }
    | { kind: 'escapedChar', char: string }
    | { kind: 'escapedHexByte', byte: number }

type ResolveGrantsParams = {
    groupMappings: LdapGroupMapping[]
    memberGroupDns: string[]
}

type ResolvedGrants = {
    platformRole: PlatformRole | null
    projectRoles: Map<string, DefaultProjectRole>
}
