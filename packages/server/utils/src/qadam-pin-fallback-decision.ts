import { isNil, ParsedQadamVersion, qadamVersionParser } from '@aiqadam/shared'

// ADR-0003 "Unavailable version" and ADR-0004 "Where a snapshot is missing", as one pure decision:
// may a step whose pinned qadam version cannot be had move to the build the image ships? It moves
// only when ALL of these hold, and the verdict names the first that does not:
//   1. the image's version is inside the pin's caret range (ADR-0001), prereleases counted
//      (ADR-0004), and never below the pin;
//   2. the props are compatible, where metadata for the pinned version exists. Only a pin the
//      catalogue positively does not list (never published: the #411 / #422 / #432 population) has
//      no props check. A pin whose metadata cannot be read is not moved, and neither is a snapshot
//      pin without its own metadata: ADR-0004 adds no exception to ADR-0003;
//   3. the target loaded successfully.
// Release pins and snapshot builds: `decide` counts prereleases inside the caret (ADR-0004), so a
// release pin may move onto a snapshot build the image ships, which `checkNet` never allows. That
// difference is deliberate: ADR-0004 lets a `-main` instance's pins follow its snapshots, and the
// audited move has the props, load and audit checks the net lacks. Reviewed and accepted in #882.
//
// It does no I/O. Whoever calls it reads the image, the metadata and the load result, and writes
// the audit record (`qadamPinMoveService`, #808). What no check here can see: a target that loads
// and describes compatible props but fails when an action runs (activepieces#15957). The audit
// record and its revert are the answer to that, not this module.
//
// The props check is a seam: `PropsCompatibilityChecker` is the shape of ADR-0001 gate 2's schema
// diff (#880's `qadamPropsCompatibility`, which the API passes in). Nothing here writes a second checker.
//
// It lives in `server-utils`, not in the API, because the engine's run-time net (`checkNet`) asks
// the same caret rule; the engine takes it through its own alias like the version store's reader.
export const qadamPinFallbackDecision = {
    // Counts prereleases inside the caret: a release pin can move onto a snapshot build (see above).
    decide: ({ pinnedVersion, image, props }: DecideParams): MoveVerdict => {
        const pin = qadamVersionParser.parsePin({ pin: pinnedVersion })
        if (isNil(pin)) {
            return stay({ reason: 'pin-unreadable', detail: 'the pin is not a release or a snapshot version' })
        }
        if (pin.range !== null) {
            return stay({ reason: 'pin-is-a-range', detail: 'a range pin resolves against what the instance holds and is not an unavailable exact version' })
        }
        if (isNil(image)) {
            return stay({ reason: 'image-lacks-qadam', detail: 'the image does not ship this qadam' })
        }
        const candidate = qadamVersionParser.parse({ version: image.version })
        if (isNil(candidate)) {
            return stay({ reason: 'image-version-unreadable', detail: `the image's build ${image.version} is not a release or a snapshot version` })
        }
        if (compare({ a: candidate, b: pin.version }) === 0) {
            return stay({ reason: 'pin-is-image-version', detail: 'the pinned version is the image\'s build, so it is available and there is nothing to move' })
        }
        if (!isInsideCaret({ pin: pin.version, candidate })) {
            return stay({ reason: 'outside-caret', detail: `the image's build ${image.version} is outside ^${pinnedVersion}` })
        }
        const propsVerdict = checkProps({ pinIsSnapshot: pin.version.snapshot !== null, props })
        if (propsVerdict.status === 'stay') {
            return propsVerdict.verdict
        }
        if (!image.load.loaded) {
            return stay({ reason: 'target-not-loaded', detail: `the image's build ${image.version} did not load: ${image.load.reason}` })
        }
        return { move: true, from: pinnedVersion, to: image.version, propsCheck: propsVerdict.propsCheck }
    },

    // What may run an exact pin that nothing holds, with no audit record and no props check: the
    // image's release build inside the caret range. The engine and the API's per-lookup fallback
    // (#424) each carried their own copy of this rule; both are nets that #808's audited move
    // replaces once every path that can move a pin does so. A snapshot pin never gets a substitute
    // here (it needs its own metadata), and a release pin never gets a snapshot build, unlike
    // `decide`, which counts prereleases inside the caret: the net has no props, load or audit check
    // to stand behind a move onto unreleased code.
    checkNet: ({ pinnedVersion, imageVersion }: CheckNetParams): NetVerdict => {
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
        if (!isInsideCaret({ pin, candidate })) {
            return { allowed: false, reason: `the image's build ${imageVersion} is outside ^${pinnedVersion}` }
        }
        return { allowed: true }
    },

    // Whether `candidate` is inside `^pin`; false when either is not a release or a snapshot.
    isInsideCaret: ({ pinnedVersion, candidateVersion }: { pinnedVersion: string, candidateVersion: string }): boolean => {
        const pin = qadamVersionParser.parse({ version: pinnedVersion })
        const candidate = qadamVersionParser.parse({ version: candidateVersion })
        return !isNil(pin) && !isNil(candidate) && isInsideCaret({ pin, candidate })
    },
}

function checkProps({ pinIsSnapshot, props }: { pinIsSnapshot: boolean, props: PropsInputs }): PropsStage {
    const { pin } = props
    if (pinIsSnapshot && pin.status !== 'found') {
        return {
            status: 'stay',
            verdict: stay({ reason: 'snapshot-without-metadata', detail: 'a snapshot pin is moved only when its own metadata.json is available to check the props against (ADR-0004)' }),
        }
    }
    if (pin.status === 'unknown') {
        return {
            status: 'stay',
            verdict: stay({ reason: 'props-unverifiable', detail: 'this instance cannot tell whether the pinned version was ever published or what it describes (the catalogue or the store cannot be read), so its props cannot be checked' }),
        }
    }
    if (pin.status === 'never-published') {
        return { status: 'ok', propsCheck: 'not-checked-no-metadata' }
    }
    if (isNil(props.target) || isNil(props.imageMetadata)) {
        return {
            status: 'stay',
            verdict: stay({ reason: 'props-unverifiable', detail: 'metadata exists for the pinned version, but the step\'s action or trigger, or the image\'s metadata, is missing to compare it with' }),
        }
    }
    const result = props.checker.check({ from: pin.metadata, to: props.imageMetadata, target: props.target })
    if (!result.compatible) {
        return { status: 'stay', verdict: stay({ reason: 'props-incompatible', detail: result.reason }) }
    }
    return { status: 'ok', propsCheck: 'compatible' }
}

function stay({ reason, detail }: { reason: StayReason, detail: string }): MoveVerdict {
    return { move: false, reason, detail }
}

// semver's caret on a release or a snapshot: the same major, or on `0.x` the same minor, on `0.0.x`
// the same patch, and never below the pin. A snapshot orders below its own release and the
// prereleases count (`^1.3.0-main.412` contains `1.3.0` and `1.4.0-main.5`, not `2.0.0-main.1`).
function isInsideCaret({ pin, candidate }: { pin: ParsedQadamVersion, candidate: ParsedQadamVersion }): boolean {
    if (compare({ a: candidate, b: pin }) < 0) {
        return false
    }
    if (candidate.major !== pin.major) {
        return false
    }
    if (pin.major > 0) {
        return true
    }
    if (candidate.minor !== pin.minor) {
        return false
    }
    if (pin.minor > 0) {
        return true
    }
    return candidate.patch === pin.patch
}

function compare({ a, b }: { a: ParsedQadamVersion, b: ParsedQadamVersion }): number {
    if (a.major !== b.major) {
        return a.major - b.major
    }
    if (a.minor !== b.minor) {
        return a.minor - b.minor
    }
    if (a.patch !== b.patch) {
        return a.patch - b.patch
    }
    if (a.snapshot === b.snapshot) {
        return 0
    }
    if (a.snapshot === null) {
        return 1
    }
    if (b.snapshot === null) {
        return -1
    }
    return a.snapshot - b.snapshot
}

type PropsStage =
    | { status: 'ok', propsCheck: PropsCheck }
    | { status: 'stay', verdict: MoveVerdict }

type DecideParams = {
    // The version stored on the step.
    pinnedVersion: string
    // What the image ships for the qadam's name, or null when it ships none.
    image: ImageBuild | null
    props: PropsInputs
}

type CheckNetParams = {
    pinnedVersion: string
    // What the image ships for the qadam's name, or null when it ships none (or no readable version).
    imageVersion: string | null
}

export type ImageBuild = {
    version: string
    load: LoadOutcome
}

export type LoadOutcome =
    | { loaded: true }
    | { loaded: false, reason: string }

export type PropsInputs = {
    pin: PinMetadata
    // `metadata.json` of the image's build.
    imageMetadata: unknown
    // The action or trigger the step uses; the props check compares that one only.
    target: StepTarget | null
    checker: PropsCompatibilityChecker
}

// What this instance knows about the pinned version's metadata. `never-published` is a positive
// answer, not a missing one: the catalogue was read and has no entry for the version (the #411 /
// #422 / #432 population, ADR-0003), and only that population skips the props check. An unreadable
// catalogue or store is `unknown`, which never moves a step.
export type PinMetadata =
    | { status: 'found', metadata: unknown }
    | { status: 'never-published' }
    | { status: 'unknown' }

export type StepTarget = {
    kind: 'action' | 'trigger'
    name: string
}

// The shape of ADR-0001 gate 2's schema diff for one action or trigger, as #880's
// `qadamPropsCompatibility.check` already has it.
export type PropsCompatibilityChecker = {
    check: (params: { from: unknown, to: unknown, target: StepTarget }) => PropsCompatibilityResult
}

export type PropsCompatibilityResult =
    | { compatible: true }
    | { compatible: false, reason: string }

export type PropsCheck = 'compatible' | 'not-checked-no-metadata'

export type StayReason =
    | 'pin-unreadable'
    | 'pin-is-a-range'
    | 'image-lacks-qadam'
    | 'image-version-unreadable'
    | 'pin-is-image-version'
    | 'outside-caret'
    | 'snapshot-without-metadata'
    | 'props-unverifiable'
    | 'props-incompatible'
    | 'target-not-loaded'

export type MoveVerdict =
    | { move: true, from: string, to: string, propsCheck: PropsCheck }
    | { move: false, reason: StayReason, detail: string }

export type NetVerdict =
    | { allowed: true }
    | { allowed: false, reason: string }
