import { afterEach, describe, expect, it } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'

const ENV_VAR = `AP_${AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED}`
const originalValue = process.env[ENV_VAR]

function setOverride(value: string | undefined): void {
    if (value === undefined) {
        delete process.env[ENV_VAR]
        return
    }
    process.env[ENV_VAR] = value
}

// `needsInstalling()`'s and `shadowKey()`'s own tests only prove the gates discriminate correctly
// once a boolean reaches them — neither can catch `systemPropDefaultValues` itself being flipped.
// This reads the real (unmocked) `system.getBoolean` the same way `machine-service.ts` does, so a
// change to the built-in default here is exactly as visible as it would be in production.
describe('OFFICIAL_QADAMS_INSTALL_ENABLED — default value', () => {
    afterEach(() => {
        setOverride(originalValue)
    })

    it('resolves to false when unset — the flag must stay off until #475/#476/#482 land', () => {
        setOverride(undefined)

        expect(system.getBoolean(AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED)).toBe(false)
    })

    it('resolves to true when explicitly set to "true"', () => {
        setOverride('true')

        expect(system.getBoolean(AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED)).toBe(true)
    })

    it('resolves to false when explicitly set to "false"', () => {
        setOverride('false')

        expect(system.getBoolean(AppSystemProp.OFFICIAL_QADAMS_INSTALL_ENABLED)).toBe(false)
    })
})
