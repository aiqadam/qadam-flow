import { PinMetadata, PropsCompatibilityChecker, qadamPinFallbackDecision, StepTarget } from '../src/qadam-pin-fallback-decision'

const TARGET: StepTarget = { kind: 'action', name: 'create_record' }
const NEVER_PUBLISHED: PinMetadata = { status: 'never-published' }
const UNKNOWN: PinMetadata = { status: 'unknown' }
const found = (metadata: unknown): PinMetadata => ({ status: 'found', metadata })
const LOADED = { loaded: true } as const

// The seam #880's checker plugs into: these fakes decide by the metadata they are handed.
const compatible: PropsCompatibilityChecker = { check: () => ({ compatible: true }) }
const incompatible: PropsCompatibilityChecker = { check: () => ({ compatible: false, reason: 'prop name was removed' }) }

function decide({ pinnedVersion, imageVersion, pinMetadata = NEVER_PUBLISHED, checker = compatible, target = TARGET, imageMetadata = { image: true }, load = LOADED }: {
    pinnedVersion: string
    imageVersion?: string | null
    pinMetadata?: PinMetadata
    checker?: PropsCompatibilityChecker
    target?: StepTarget | null
    imageMetadata?: unknown
    load?: { loaded: true } | { loaded: false, reason: string }
}) {
    return qadamPinFallbackDecision.decide({
        pinnedVersion,
        image: imageVersion === null ? null : { version: imageVersion ?? '1.4.2', load },
        props: { pin: pinMetadata, imageMetadata, target, checker },
    })
}

describe('qadamPinFallbackDecision.decide: the caret range', () => {
    it.each([
        { pin: '1.2.0', image: '1.4.2' },
        { pin: '1.2.0', image: '1.2.1' },
        { pin: '0.3.1', image: '0.3.5' },
    ])('moves: pin $pin with the image at $image is inside the caret range', ({ pin, image }) => {
        expect(decide({ pinnedVersion: pin, imageVersion: image }).move).toBe(true)
    })

    it.each([
        { pin: '1.2.0', image: '2.0.0' },
        { pin: '1.2.0', image: '1.1.9' },
        { pin: '0.3.1', image: '0.4.5' },
        { pin: '0.3.5', image: '0.3.1' },
        { pin: '0.0.3', image: '0.0.4' },
        { pin: '0.0.3', image: '0.1.0' },
        { pin: '0.0.3', image: '0.0.3-main.9' },
    ])('stays: pin $pin with the image at $image is outside the caret range', ({ pin, image }) => {
        expect(decide({ pinnedVersion: pin, imageVersion: image })).toMatchObject({ move: false, reason: 'outside-caret' })
    })

    it('counts prereleases inside the caret (ADR-0004)', () => {
        expect(decide({ pinnedVersion: '1.2.0', imageVersion: '1.3.0-main.5' })).toMatchObject({ move: true, to: '1.3.0-main.5' })
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.2-main.7' })).toMatchObject({ move: true })
    })

    it('keeps a prerelease of the next major outside the caret', () => {
        expect(decide({ pinnedVersion: '1.2.0', imageVersion: '2.0.0-main.1' })).toMatchObject({ move: false, reason: 'outside-caret' })
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.4.0-main.1' })).toMatchObject({ move: false, reason: 'outside-caret' })
    })

    it('puts a snapshot below its own release: a release is a candidate for the snapshot pin, an earlier snapshot is not', () => {
        const metadata = { pinned: true }
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0', pinMetadata: found(metadata) })).toMatchObject({ move: true })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0-main.500', pinMetadata: found(metadata) })).toMatchObject({ move: true })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0-main.400', pinMetadata: found(metadata) })).toMatchObject({ move: false, reason: 'outside-caret' })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.2.9', pinMetadata: found(metadata) })).toMatchObject({ move: false, reason: 'outside-caret' })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '2.0.0', pinMetadata: found(metadata) })).toMatchObject({ move: false, reason: 'outside-caret' })
    })

    it('reports a pin that is the image\'s own build as available, not as a move', () => {
        expect(decide({ pinnedVersion: '1.4.2', imageVersion: '1.4.2' })).toMatchObject({ move: false, reason: 'pin-is-image-version' })
    })
})

describe('qadamPinFallbackDecision.decide: what the pin and the image look like', () => {
    it('stays when the pin is not a release or a snapshot', () => {
        for (const pinnedVersion of ['latest', '', '1.2', '1.2.0-beta.1', '1.2.0 trailing']) {
            expect(decide({ pinnedVersion })).toMatchObject({ move: false, reason: 'pin-unreadable' })
        }
    })

    it('leaves a range pin alone: it resolves against what the instance holds', () => {
        expect(decide({ pinnedVersion: '^1.2.0' })).toMatchObject({ move: false, reason: 'pin-is-a-range' })
        expect(decide({ pinnedVersion: '~1.2.0' })).toMatchObject({ move: false, reason: 'pin-is-a-range' })
    })

    it('stays when the image does not ship the qadam', () => {
        expect(decide({ pinnedVersion: '1.2.0', imageVersion: null })).toMatchObject({ move: false, reason: 'image-lacks-qadam' })
    })

    it('stays when the image\'s version is not readable', () => {
        expect(decide({ pinnedVersion: '1.2.0', imageVersion: '1.4.2-rc.1' })).toMatchObject({ move: false, reason: 'image-version-unreadable' })
    })
})

describe('qadamPinFallbackDecision.decide: the props check', () => {
    it('has no props check for a pin with no metadata, and says so', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5' })).toEqual({ move: true, from: '0.3.1', to: '0.3.5', propsCheck: 'not-checked-no-metadata' })
    })

    it('does not ask the checker when there is no metadata', () => {
        const check = vi.fn(() => ({ compatible: false as const, reason: 'never' }))
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', checker: { check } }).move).toBe(true)
        expect(check).not.toHaveBeenCalled()
    })

    it('moves when the metadata exists and the checker finds the props compatible', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }) })).toEqual({ move: true, from: '0.3.1', to: '0.3.5', propsCheck: 'compatible' })
    })

    it('hands the checker both versions\' metadata and the step\'s action', () => {
        const check = vi.fn(() => ({ compatible: true as const }))
        const pinMetadata = found({ pinned: true })
        const imageMetadata = { image: true }

        decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata, imageMetadata, checker: { check } })

        expect(check).toHaveBeenCalledWith({ from: { pinned: true }, to: imageMetadata, target: TARGET })
    })

    it('stays, with the checker\'s reason, when the props are not compatible', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }), checker: incompatible }))
            .toEqual({ move: false, reason: 'props-incompatible', detail: 'prop name was removed' })
    })

    it('stays when metadata exists but the step\'s action or the image\'s metadata is missing', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }), target: null }))
            .toMatchObject({ move: false, reason: 'props-unverifiable' })
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }), imageMetadata: null }))
            .toMatchObject({ move: false, reason: 'props-unverifiable' })
    })

    it('does not move a release pin when the instance cannot tell whether it was ever published', () => {
        const check = vi.fn(() => ({ compatible: true as const }))

        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: UNKNOWN, checker: { check } }))
            .toMatchObject({ move: false, reason: 'props-unverifiable' })
        expect(check).not.toHaveBeenCalled()
    })

    it('does not move a snapshot pin without its own metadata (ADR-0004 adds no exception)', () => {
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0', pinMetadata: UNKNOWN })).toMatchObject({ move: false, reason: 'snapshot-without-metadata' })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0' })).toMatchObject({ move: false, reason: 'snapshot-without-metadata' })
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0', pinMetadata: UNKNOWN })).toMatchObject({ move: false, reason: 'snapshot-without-metadata' })
    })

    it('moves a snapshot pin that has metadata and compatible props', () => {
        expect(decide({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.1', pinMetadata: found({ pinned: true }) }))
            .toEqual({ move: true, from: '1.3.0-main.412', to: '1.3.1', propsCheck: 'compatible' })
    })

    it('does not check the props of a target outside the caret range', () => {
        const check = vi.fn(() => ({ compatible: true as const }))
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.4.5', pinMetadata: found({ pinned: true }), checker: { check } }).move).toBe(false)
        expect(check).not.toHaveBeenCalled()
    })
})

describe('qadamPinFallbackDecision.decide: the load check', () => {
    it('stays when the target did not load, with the reason', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', load: { loaded: false, reason: 'import.meta in CJS' } }))
            .toEqual({ move: false, reason: 'target-not-loaded', detail: 'the image\'s build 0.3.5 did not load: import.meta in CJS' })
    })

    it('stays on a failed load even when every other check passes', () => {
        const verdict = decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }), load: { loaded: false, reason: 'x' } })
        expect(verdict).toMatchObject({ move: false, reason: 'target-not-loaded' })
    })

    it('reports an incompatible prop before a failed load', () => {
        expect(decide({ pinnedVersion: '0.3.1', imageVersion: '0.3.5', pinMetadata: found({ pinned: true }), checker: incompatible, load: { loaded: false, reason: 'x' } }))
            .toMatchObject({ reason: 'props-incompatible' })
    })
})

describe('qadamPinFallbackDecision.checkNet: what may run an exact pin with no audit', () => {
    it.each([
        { pinnedVersion: '1.2.0', imageVersion: '1.2.0', allowed: true },
        { pinnedVersion: '1.2.0', imageVersion: '1.9.4', allowed: true },
        { pinnedVersion: '0.3.1', imageVersion: '0.3.5', allowed: true },
        { pinnedVersion: '1.2.0', imageVersion: '1.1.9', allowed: false },
        { pinnedVersion: '1.2.0', imageVersion: '2.0.0', allowed: false },
        { pinnedVersion: '0.3.1', imageVersion: '0.4.0', allowed: false },
        { pinnedVersion: '0.3.5', imageVersion: '0.3.1', allowed: false },
        { pinnedVersion: '0.0.3', imageVersion: '0.0.4', allowed: false },
        { pinnedVersion: '1.2.0', imageVersion: null, allowed: false },
    ])('pin $pinnedVersion with the image at $imageVersion: allowed $allowed', ({ pinnedVersion, imageVersion, allowed }) => {
        expect(qadamPinFallbackDecision.checkNet({ pinnedVersion, imageVersion }).allowed).toBe(allowed)
    })

    it('never gives a snapshot pin a substitute, and never gives a release pin a snapshot build', () => {
        expect(qadamPinFallbackDecision.checkNet({ pinnedVersion: '1.3.0-main.412', imageVersion: '1.3.0' }).allowed).toBe(false)
        expect(qadamPinFallbackDecision.checkNet({ pinnedVersion: '1.2.0', imageVersion: '1.2.5-main.9' }).allowed).toBe(false)
    })

    it('refuses a pin that is not a release or a snapshot', () => {
        expect(qadamPinFallbackDecision.checkNet({ pinnedVersion: '^1.2.0', imageVersion: '1.2.0' }).allowed).toBe(false)
        expect(qadamPinFallbackDecision.checkNet({ pinnedVersion: '1.2.0-beta.1', imageVersion: '1.2.0' }).allowed).toBe(false)
    })
})

describe('qadamPinFallbackDecision.isInsideCaret', () => {
    it('answers false for anything that is not a version, instead of throwing', () => {
        expect(qadamPinFallbackDecision.isInsideCaret({ pinnedVersion: 'latest', candidateVersion: '1.0.0' })).toBe(false)
        expect(qadamPinFallbackDecision.isInsideCaret({ pinnedVersion: '1.0.0', candidateVersion: '1.0' })).toBe(false)
        expect(qadamPinFallbackDecision.isInsideCaret({ pinnedVersion: '1.0.0', candidateVersion: '1.5.0' })).toBe(true)
    })
})
