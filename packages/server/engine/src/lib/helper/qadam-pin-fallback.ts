import { isNil, ParsedQadamVersion, qadamVersionParser } from '@aiqadam/shared'

// The one place that still lets an exact pin run on a different build than the one it names: the
// image's build of the same qadam, when it sits inside the pin's caret range. It is what runs
// today's stale pins (the #411 / #432 population: pins to versions that were never published, so
// neither the store nor the image can hold them) until #808's checked, audited fallback exists to
// move them properly. That ticket replaces this module: deleting it makes every unavailable pin
// fail with the pin named, and nothing else in the loader has to change.
//
// ADR-0003 allows a move only inside the caret range (ADR-0001), and ADR-0004 keeps a snapshot pin
// exact: moving one needs the snapshot's own `metadata.json` and a props check, which only #808
// does. So a snapshot pin never gets a substitute here, whatever the image carries, and neither
// does a release pin get a snapshot build (a release number names released bytes).
export const qadamPinFallback = {
    check: ({ pinnedVersion, imageVersion }: CheckParams): QadamPinFallbackVerdict => {
        const pin = qadamVersionParser.parse({ version: pinnedVersion })
        if (isNil(pin)) {
            return { allowed: false, reason: 'the pin is not a release or a snapshot version' }
        }
        if (pin.snapshot !== null) {
            return { allowed: false, reason: 'a snapshot pin is exact and is moved only by the checked fallback (#808, ADR-0004)' }
        }
        if (isNil(imageVersion)) {
            return { allowed: false, reason: 'the image does not ship this qadam' }
        }
        const candidate = qadamVersionParser.parse({ version: imageVersion })
        if (isNil(candidate) || candidate.snapshot !== null) {
            return { allowed: false, reason: `the image's build ${imageVersion} is not a release` }
        }
        if (!isInsideCaretRange({ pin, candidate })) {
            return { allowed: false, reason: `the image's build ${imageVersion} is outside ^${pinnedVersion}` }
        }
        return { allowed: true }
    },
}

// semver's caret on two releases: the same major, or on `0.x` the same minor, and on `0.0.x` the
// same patch; never below the pin. The API's `satisfiesRequestedRange` is the same rule.
function isInsideCaretRange({ pin, candidate }: { pin: ParsedQadamVersion, candidate: ParsedQadamVersion }): boolean {
    if (candidate.major !== pin.major) {
        return false
    }
    if (pin.major > 0) {
        return isAtLeast({ candidate, pin })
    }
    if (candidate.minor !== pin.minor) {
        return false
    }
    if (pin.minor > 0) {
        return isAtLeast({ candidate, pin })
    }
    return candidate.patch === pin.patch
}

function isAtLeast({ candidate, pin }: { candidate: ParsedQadamVersion, pin: ParsedQadamVersion }): boolean {
    if (candidate.minor !== pin.minor) {
        return candidate.minor > pin.minor
    }
    return candidate.patch >= pin.patch
}

type CheckParams = {
    pinnedVersion: string
    // What the image ships for the qadam's name, or null when it ships none (or no readable version).
    imageVersion: string | null
}

export type QadamPinFallbackVerdict =
    | { allowed: true }
    | { allowed: false, reason: string }
