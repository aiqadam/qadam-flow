import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_CUSTOM_PROVIDERS_PER_PLATFORM, getMaxCustomProvidersPerPlatform } from '../../../../src/app/ai/ai-provider-service'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'

const ENV_VAR = `AP_${AppSystemProp.MAX_CUSTOM_AI_PROVIDERS_PER_PLATFORM}`
const originalValue = process.env[ENV_VAR]

const setOverride = (value: string | undefined) => {
    if (value === undefined) {
        delete process.env[ENV_VAR]
        return
    }
    process.env[ENV_VAR] = value
}

// The wired path can only report the resolved cap through a 403, and a 403 needs the platform to
// already hold that many custom rows — twenty creates, each with its own HTTP round trip, to pin
// one number. So the integration file pins the cap with a small override and proves that an
// unusable override does not *remove* it; what the fallback resolves to is left here, where a
// fallback of Infinity or Number.MAX_SAFE_INTEGER is caught for the cost of a function call.
// These read the number back directly, and go through the real `system.getNumber` via the real
// environment rather than a stub that reimplements its parse.
describe('custom AI providers per platform cap', () => {
    afterEach(() => {
        setOverride(originalValue)
    })

    // The `unset` row does not travel through the fallback branch: `systemPropDefaultValues`
    // already answers '20' for this prop, so it pins that that default and
    // DEFAULT_MAX_CUSTOM_PROVIDERS_PER_PLATFORM — two hardcoded twenties in two files — agree.
    // The other four are the fallback.
    it.each([
        ['unset', undefined],
        ['empty', ''],
        ['unparseable', 'not-a-number'],
        ['zero', '0'],
        ['negative', '-1'],
    ])('resolves a %s override to the built-in default, never to unlimited', (_label, override) => {
        setOverride(override)

        expect(getMaxCustomProvidersPerPlatform()).toBe(DEFAULT_MAX_CUSTOM_PROVIDERS_PER_PLATFORM)
        expect(Number.isSafeInteger(getMaxCustomProvidersPerPlatform())).toBe(true)
    })

    it('honours a usable override', () => {
        setOverride('3')

        expect(getMaxCustomProvidersPerPlatform()).toBe(3)
    })

    // `system.getNumber` uses `Number.parseInt`, so a leading numeric prefix wins and only a value
    // with no leading digits at all falls back. Both of these resolve below the default, so the
    // direction is fail-closed — but the environment-variables doc has to say this rather than
    // promise a fallback that does not happen, which is what these two pin.
    it.each([
        ['12abc', 12],
        ['1e3', 1],
    ])('reads %j as a live cap of %i rather than falling back', (override, expected) => {
        setOverride(override)

        expect(getMaxCustomProvidersPerPlatform()).toBe(expected)
    })
})
