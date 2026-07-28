import { FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { validateEnvPropsOnStartup, validateSystemPropTypes } from '../../../../src/app/helper/system-validator'

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

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

describe('validateEnvPropsOnStartup AP_DB_TYPE', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const withDbType = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
        const previousDbType = process.env.AP_DB_TYPE
        if (value === undefined) {
            delete process.env.AP_DB_TYPE
        }
        else {
            process.env.AP_DB_TYPE = value
        }
        try {
            await run()
        }
        finally {
            if (previousDbType === undefined) {
                delete process.env.AP_DB_TYPE
            }
            else {
                process.env.AP_DB_TYPE = previousDbType
            }
        }
    }

    it('throws a clear, actionable error for the removed AP_DB_TYPE=PGLITE, not a downstream stack trace', async () => {
        await withDbType('PGLITE', async () => {
            await expect(validateEnvPropsOnStartup(mockLog)).rejects.toThrow(/PGLite support has been removed/)
        })
    })

    it('throws for the older, already-deprecated AP_DB_TYPE=SQLITE3 rather than silently mapping it', async () => {
        await withDbType('SQLITE3', async () => {
            await expect(validateEnvPropsOnStartup(mockLog)).rejects.toThrow(/Invalid AP_DB_TYPE="SQLITE3"/)
        })
    })

    it('does not reject on account of AP_DB_TYPE when it is POSTGRES', async () => {
        await withDbType('POSTGRES', async () => {
            await validateEnvPropsOnStartup(mockLog).catch((error: unknown) => {
                expect(String(error)).not.toMatch(/AP_DB_TYPE/)
            })
        })
    })
})
