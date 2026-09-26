export const ldapFilterUtils = {
    escapeFilterValue,
    buildUserSearchFilter,
}

// RFC 4515 §3: a filter value must escape the five octets the grammar itself uses as
// metacharacters, plus NUL — a value that reaches the wire unescaped can close the enclosing
// `(uid=...)` term early and splice in extra filter terms (the classic `)(uid=*` /
// `*)(objectClass=*` bypass of an "exactly one entry" search).
const ESCAPE_MAP: Record<string, string> = {
    '\\': '\\5c',
    '*': '\\2a',
    '(': '\\28',
    ')': '\\29',
    '\u0000': '\\00',
}

function escapeFilterValue(value: string): string {
    return Array.from(value).map((char) => ESCAPE_MAP[char] ?? char).join('')
}

// `userFilter` is validated at save time to contain the `{username}` placeholder exactly once
// (`LdapConfig.userFilter`), so a single substitution is enough — but it must not be
// `String.replace(pattern, replacementString)`: when the second argument is a string, `replace`
// treats `$&`, `` $` ``, `$'` and `$$` in it as special substitution patterns, not literal text.
// An escaped username that happens to contain one of those sequences (none of them are LDAP
// metacharacters, so `escapeFilterValue` passes them through untouched) would then splice in the
// wrong text — the match itself, everything before/after it, or a literal `$` — instead of the
// username. `split`/`join` are plain string operations with no such special-casing.
function buildUserSearchFilter({ userFilter, username }: BuildUserSearchFilterParams): string {
    return userFilter.split('{username}').join(escapeFilterValue(username))
}

type BuildUserSearchFilterParams = {
    userFilter: string
    username: string
}
