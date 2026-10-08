import { describe, expect, it } from 'vitest'
import { isSupportedRelease } from '../../../../src/app/qadams/metadata/utils/qadam-cache-utils'

// Images built from `main` report `<next>-main.<n>` (ADR-0001, #798). These pin how the catalogue
// filter reads that number: in semver's own order, so a canary meets the floors of every release it
// was built after and never claims the release it leads to.
describe('isSupportedRelease with a main-build platform version', () => {
    const MAIN_BUILD = '2.1.0-main.5'

    it.each([
        ['0.82.0', 'the framework floor every official qadam really reports'],
        ['1.1.0', 'an older release'],
        ['2.0.0', 'the last release, which the build was cut after'],
        ['2.0.9', 'a patch of the last release line'],
        ['2.1.0-main.5', 'a floor equal to this very build'],
        ['2.1.0-main.4', 'an earlier build of the same line'],
    ])('meets a minimumSupportedRelease of %s (%s)', (floor) => {
        expect(isSupportedRelease(MAIN_BUILD, { minimumSupportedRelease: floor })).toBe(true)
    })

    it.each([
        ['2.1.0', 'the unreleased <next> itself — a canary never claims a release it is not'],
        ['2.1.0-main.6', 'a later build of the same line'],
        ['2.2.0', 'a later release'],
    ])('does not meet a minimumSupportedRelease of %s (%s)', (floor) => {
        expect(isSupportedRelease(MAIN_BUILD, { minimumSupportedRelease: floor })).toBe(false)
    })

    it.each([
        ['2.1.0', 'the release this build leads to'],
        ['2.1.0-main.5', 'this very build'],
        ['3.0.0', 'a later major'],
    ])('stays within a maximumSupportedRelease of %s (%s)', (ceiling) => {
        expect(isSupportedRelease(MAIN_BUILD, { maximumSupportedRelease: ceiling })).toBe(true)
    })

    it.each([
        ['2.0.0', 'the last release: the build already carries changes after it'],
        ['2.1.0-main.4', 'an earlier build of the same line'],
    ])('is past a maximumSupportedRelease of %s (%s)', (ceiling) => {
        expect(isSupportedRelease(MAIN_BUILD, { maximumSupportedRelease: ceiling })).toBe(false)
    })

    it('orders the counter numerically, not as text (main.10 is after main.9)', () => {
        expect(isSupportedRelease('2.1.0-main.10', { minimumSupportedRelease: '2.1.0-main.9' })).toBe(true)
        expect(isSupportedRelease('2.1.0-main.9', { minimumSupportedRelease: '2.1.0-main.10' })).toBe(false)
    })

    it('treats the first main build after the #798 realignment like any other: 2.0.0-main.n is past 1.1.0 and short of 2.0.0', () => {
        expect(isSupportedRelease('2.0.0-main.1234', { minimumSupportedRelease: '1.1.0', maximumSupportedRelease: '2.0.0' })).toBe(true)
        expect(isSupportedRelease('2.0.0-main.1234', { minimumSupportedRelease: '2.0.0' })).toBe(false)
    })
})
