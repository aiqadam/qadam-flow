import { DefaultProjectRole, isNil, LdapGroupMapping, PlatformRole } from '@aiqadam/shared'

export const ldapGroupMappingUtils = {
    normalizeGroupDn,
    resolveGrants,
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

// Round 2 (app-sec): a naive `.trim().toLowerCase().split(',')` is a privilege-escalation hole,
// not just an approximation. Three concrete ways a spoofed DN could pass as equal to a real one
// under it: (1) `String#trim()` strips every ECMAScript "WhiteSpace" character, which includes
// U+00A0 NBSP — a group named with a trailing NBSP would compare equal to the real group;
// (2) `String#toLowerCase()` performs full Unicode case folding, which maps lookalike codepoints
// (e.g. U+212A KELVIN SIGN) onto plain ASCII letters — a group name built from such a codepoint
// would compare equal to the real ASCII spelling; (3) splitting on every literal `,` ignores RFC
// 4515's `\,` escape, so an *escaped* comma inside a value (part of the value, not a separator)
// gets treated as a component boundary, letting an attacker-chosen value with a differently-placed
// escaped comma/space collide with an unrelated real DN.
//
// This is a minimal RFC 4514 tokeniser, not a full parser (no attribute-type OID/short-name
// equivalence, no semantic ordering of multi-valued RDNs) — deliberately scoped to close the three
// holes above: split only on UNescaped `,`/`+`, trim only literal ASCII space (0x20, never NBSP or
// any other WhiteSpace-adjacent character) at each component's boundary, and lowercase only ASCII
// `A`-`Z` (never fold non-ASCII codepoints). Trimming happens on the still-escaped raw component
// (before `\`-sequences are resolved), so a component that legitimately *starts or ends* with an
// escaped space (`\ Admins`) is never confused with incidental DN-formatting whitespace and
// stripped by mistake.
function normalizeGroupDn(dn: string): string {
    return splitOnUnescapedSeparators(dn)
        .map((rawComponent) => lowercaseAsciiOnly(unescapeComponent(trimRawAsciiSpaces(rawComponent))))
        .join(',')
}

// Splits on a top-level (unescaped) `,` or `+` — RFC 4514's RDN/attribute-value separators — while
// keeping every escape sequence exactly as written (backslash + one char, or a `\XX` hex pair) for
// the boundary-trim step that runs next; unescaping happens only after that.
function splitOnUnescapedSeparators(dn: string): string[] {
    const parts: string[] = []
    let current = ''
    let i = 0
    while (i < dn.length) {
        const char = dn[i]
        if (char === '\\' && i + 1 < dn.length) {
            const isHexEscape = /^[0-9a-fA-F]{2}/.test(dn.slice(i + 1, i + 3))
            const escapeLength = isHexEscape ? 3 : 2
            current += dn.slice(i, i + escapeLength)
            i += escapeLength
            continue
        }
        if (char === ',' || char === '+') {
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

// Strips only a literal ASCII space (0x20) from each end of the *raw* (still-escaped) component —
// never any other whitespace character, and never a `\`-escaped one, since the escape sequence at
// that position starts with `\`, not with a bare space.
function trimRawAsciiSpaces(raw: string): string {
    let start = 0
    let end = raw.length
    while (start < end && raw.charCodeAt(start) === 0x20) {
        start += 1
    }
    while (end > start && raw.charCodeAt(end - 1) === 0x20) {
        end -= 1
    }
    return raw.slice(start, end)
}

// Resolves RFC 4514's escapes: `\` followed by a hex pair is that literal byte; `\` followed by
// any other character (`,`, `+`, `"`, `\`, `<`, `>`, `;`, `=`, or a leading `#`/space) is that
// character literally. Runs after boundary-trimming, so an escaped space this unescapes never gets
// mistaken for trimmable whitespace by a later step.
function unescapeComponent(raw: string): string {
    let result = ''
    let i = 0
    while (i < raw.length) {
        if (raw[i] === '\\' && i + 1 < raw.length) {
            const isHexEscape = /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1, i + 3))
            if (isHexEscape) {
                result += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16))
                i += 3
                continue
            }
            result += raw[i + 1]
            i += 2
            continue
        }
        result += raw[i]
        i += 1
    }
    return result
}

const ASCII_UPPER_A = 0x41
const ASCII_UPPER_Z = 0x5a
const ASCII_CASE_OFFSET = 0x20

// Deliberately ASCII-only — `String#toLowerCase()`'s full Unicode case folding is exactly the
// homoglyph hole this function exists to close (see the comment on `normalizeGroupDn`).
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

type ResolveGrantsParams = {
    groupMappings: LdapGroupMapping[]
    memberGroupDns: string[]
}

type ResolvedGrants = {
    platformRole: PlatformRole | null
    projectRoles: Map<string, DefaultProjectRole>
}
