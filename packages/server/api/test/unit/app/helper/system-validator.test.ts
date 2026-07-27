import { afterEach, describe, expect, it, vi } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { validateSystemPropTypes } from '../../../../src/app/helper/system-validator'

describe('validateSystemPropTypes', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reads every AppSystemProp exactly once, not twice', () => {
        const getSpy = vi.spyOn(system, 'get')

        validateSystemPropTypes()

        expect(getSpy).toHaveBeenCalledTimes(Object.values(AppSystemProp).length)
    })

    it('only ever checks props found in AppSystemProp, never a duplicate entry', () => {
        const getSpy = vi.spyOn(system, 'get')

        validateSystemPropTypes()

        const seenProps = getSpy.mock.calls.map(([prop]) => prop)
        expect(new Set(seenProps).size).toBe(seenProps.length)
    })

    it('flags a malformed value for a validated prop, reading it exactly once', () => {
        const previousLogLevel = process.env.AP_LOG_LEVEL
        process.env.AP_LOG_LEVEL = 'not-a-real-level'
        const getSpy = vi.spyOn(system, 'get')

        try {
            const errors = validateSystemPropTypes()

            expect(errors[AppSystemProp.LOG_LEVEL]).toContain('Current value: not-a-real-level')
            // The error map is keyed by prop, so a duplicated pass overwrites rather than appends and
            // the assertion above cannot see it. Count the reads instead.
            const logLevelReads = getSpy.mock.calls.filter(([prop]) => prop === AppSystemProp.LOG_LEVEL)
            expect(logLevelReads).toHaveLength(1)
        }
        finally {
            if (previousLogLevel === undefined) {
                delete process.env.AP_LOG_LEVEL
            }
            else {
                process.env.AP_LOG_LEVEL = previousLogLevel
            }
        }
    })
})
