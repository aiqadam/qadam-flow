// ADR-0004 "Pin format": the one place that decides what a qadam version may look like. A release
// `x.y.z` or a snapshot `x.y.z-main.<n>` (what a build from `main` gives a changed package), and no
// other prerelease. The step-settings and request schemas, the platform release in the registry
// query, the alias, the worker's cache, the store's coordinates and the engine's same-version match
// all ask this module instead of carrying a pattern of their own.
const NUMBER = '(?:0|[1-9][0-9]{0,8})'
const SNAPSHOT_CHANNEL = 'main'
// Numbers carry no leading zero (semver's canonical form, which is also what the version store
// accepted before this parser) and at most nine digits. That limit is now the only bound on a
// version's length: the longest one is `999999999.999999999.999999999-main.999999999`, 44 characters.
const CORE_SOURCE = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`
const CAPTURED_CORE_SOURCE = `(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})`
const VERSION_SOURCE = `${CAPTURED_CORE_SOURCE}(?:-${SNAPSHOT_CHANNEL}\\.(${NUMBER}))?`

// The longest string the grammar accepts: `999999999.999999999.999999999-main.999999999`.
export const QADAM_VERSION_MAX_LENGTH = `${'9'.repeat(9)}.${'9'.repeat(9)}.${'9'.repeat(9)}-${SNAPSHOT_CHANNEL}.${'9'.repeat(9)}`.length

export const QADAM_VERSION_PATTERN = `^${VERSION_SOURCE}$`
export const QADAM_RELEASE_PATTERN = `^${CORE_SOURCE}$`
// The one capturing pattern of a pin: group 1 is the optional `^` or `~`, groups 2-5 the version.
export const QADAM_PIN_PATTERN = `^([~^])?${VERSION_SOURCE}$`

const QADAM_VERSION_REGEX = new RegExp(QADAM_VERSION_PATTERN)
const QADAM_PIN_REGEX = new RegExp(QADAM_PIN_PATTERN)
// A legacy alias `name-version`: the version is the longest tail that is one, so the `-main.<n>` of a
// snapshot stays with the version and not with the name.
const LEGACY_ALIAS_REGEX = new RegExp(`^(.+?)-(${VERSION_SOURCE})$`)

export const qadamVersionParser = {
    // `null` for anything that is not a release or a snapshot: a range, a `v` prefix, another
    // prerelease, build metadata, a leading zero, trailing whitespace.
    parse: ({ version }: { version: string }): ParsedQadamVersion | null => {
        return toParsed({ match: QADAM_VERSION_REGEX.exec(version) })
    },

    // A step's stored pin: a version with an optional `^` or `~` in front.
    parsePin: ({ pin }: { pin: string }): ParsedQadamPin | null => {
        const match = QADAM_PIN_REGEX.exec(pin)
        const parsed = toParsed({ match, offset: 1 })
        if (match === null || parsed === null) {
            return null
        }
        return { range: parseRange({ prefix: match[1] }), version: parsed }
    },

    isRelease: ({ version }: { version: string }): boolean => {
        return qadamVersionParser.parse({ version })?.snapshot === null
    },

    isSnapshot: ({ version }: { version: string }): boolean => {
        const snapshot = qadamVersionParser.parse({ version })?.snapshot
        return snapshot !== undefined && snapshot !== null
    },

    // `1.3.0` for `1.3.0-main.412`.
    getBase: ({ version }: { version: string }): string | null => {
        const parsed = qadamVersionParser.parse({ version })
        return parsed === null ? null : `${parsed.major}.${parsed.minor}.${parsed.patch}`
    },

    // A pin the worker and the API can use as it stands: no `^` or `~` to resolve first.
    isExact: ({ version }: { version: string }): boolean => {
        return qadamVersionParser.parse({ version }) !== null
    },

    // The only splitter of an alias. `name@version` splits at the last `@` after the first
    // character (a scoped name starts with one); the legacy `name-version` is read too, because
    // existing `qadams/<name>-<version>` workspace directories carry it. A name that merely ends in
    // digits and a hyphen is not split unless the tail is a whole version.
    parseAlias: ({ alias }: { alias: string }): ParsedQadamAlias | null => {
        const separator = alias.lastIndexOf('@')
        if (separator > 0) {
            const name = alias.slice(0, separator)
            const version = alias.slice(separator + 1)
            return qadamVersionParser.parse({ version }) === null ? null : { name, version, isLegacy: false }
        }
        const legacy = LEGACY_ALIAS_REGEX.exec(alias)
        if (legacy === null) {
            return null
        }
        return { name: legacy[1], version: legacy[2], isLegacy: true }
    },
}

function toParsed({ match, offset = 0 }: { match: RegExpExecArray | null, offset?: number }): ParsedQadamVersion | null {
    if (match === null) {
        return null
    }
    const [major, minor, patch, snapshot] = match.slice(offset + 1, offset + 5)
    return {
        major: Number(major),
        minor: Number(minor),
        patch: Number(patch),
        snapshot: snapshot === undefined ? null : Number(snapshot),
    }
}

function parseRange({ prefix }: { prefix: string | undefined }): QadamPinRange | null {
    switch (prefix) {
        case '^':
            return '^'
        case '~':
            return '~'
        default:
            return null
    }
}

export type ParsedQadamVersion = {
    major: number
    minor: number
    patch: number
    // The `<n>` of `x.y.z-main.<n>`; `null` for a release.
    snapshot: number | null
}

export type QadamPinRange = '^' | '~'

export type ParsedQadamPin = {
    range: QadamPinRange | null
    version: ParsedQadamVersion
}

export type ParsedQadamAlias = {
    name: string
    version: string
    isLegacy: boolean
}
