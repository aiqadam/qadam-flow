import { FastifyBaseLogger } from 'fastify'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { validateEnvPropsOnStartup, validateSystemPropTypes } from '../../../../src/app/helper/system-validator'

// A real (silenced) pino logger structurally satisfies FastifyBaseLogger — see
// `pinoLogging.initLogger()` in `helper/logger/index.ts`, which is assigned to a
// `FastifyBaseLogger`-typed variable the same way — so no mock object or cast is needed.
const mockLog: FastifyBaseLogger = pino({ level: 'silent' })

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

    // Runs validateEnvPropsOnStartup and reports whether it rejected specifically over
    // AP_DB_TYPE — as opposed to any other startup check (encryption key, JWT secret, ...)
    // this unit test's environment may not satisfy. The assertion always runs, whichever
    // branch is taken, so it cannot pass vacuously.
    const rejectedOverDbType = async (): Promise<boolean> => {
        try {
            await validateEnvPropsOnStartup(mockLog)
            return false
        }
        catch (error: unknown) {
            return /AP_DB_TYPE/.test(String(error))
        }
    }

    it('does not reject on account of AP_DB_TYPE when it is POSTGRES', async () => {
        await withDbType('POSTGRES', async () => {
            expect(await rejectedOverDbType()).toBe(false)
        })
    })

    // These three shapes were all silently accepted before PGLite removal — the old code
    // was `switch (databaseType) { case PGLITE: ...; default: return createPostgresDataSource() }`
    // with only a `log.warn` from the enum validator, so anything that was not exactly
    // "PGLITE" booted on Postgres. A stricter post-removal check must not turn any of them
    // into a new outage.
    it('does not reject for an empty AP_DB_TYPE (a blank .env line, or an unexported compose interpolation)', async () => {
        await withDbType('', async () => {
            expect(await rejectedOverDbType()).toBe(false)
        })
    })

    it('does not reject for a lower-cased AP_DB_TYPE value', async () => {
        await withDbType('postgres', async () => {
            expect(await rejectedOverDbType()).toBe(false)
        })
    })

    it('does not reject for a whitespace-padded AP_DB_TYPE value (trailing space or CR)', async () => {
        await withDbType('POSTGRES \r', async () => {
            expect(await rejectedOverDbType()).toBe(false)
        })
    })
})
