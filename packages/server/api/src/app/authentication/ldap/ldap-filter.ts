// RFC 4515 ยง3: a filter value must escape the five octets the grammar itself uses as
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
// (`LdapConfig.userFilter`), so a single, non-overlapping replace is enough here.
function buildUserSearchFilter({ userFilter, username }: BuildUserSearchFilterParams): string {
    return userFilter.replace('{username}', escapeFilterValue(username))
}

export const ldapFilterUtils = {
    escapeFilterValue,
    buildUserSearchFilter,
}

type BuildUserSearchFilterParams = {
    userFilter: string
    username: string
}
