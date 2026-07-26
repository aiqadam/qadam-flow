import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS_UNDER_TEST = ['AP_JWT_SECRET', 'QF_JWT_SECRET']

describe('environmentMigrations QF_/AP_ prefix aliasing', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        for (const key of ENV_KEYS_UNDER_TEST) {
            delete process.env[key]
        }
    })

    afterEach(() => {
        for (const key of ENV_KEYS_UNDER_TEST) {
            delete process.env[key]
        }
        Object.assign(process.env, originalEnv)
    })

    it('falls back to AP_ when only the legacy name is set', async () => {
        process.env.AP_JWT_SECRET = 'legacy-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate().AP_JWT_SECRET).toBe('legacy-secret')
    })

    it('resolves QF_ when only the new name is set', async () => {
        process.env.QF_JWT_SECRET = 'new-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate().AP_JWT_SECRET).toBe('new-secret')
    })

    it('prefers QF_ over AP_ when both are set (deterministic precedence)', async () => {
        process.env.AP_JWT_SECRET = 'legacy-secret'
        process.env.QF_JWT_SECRET = 'new-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate().AP_JWT_SECRET).toBe('new-secret')
    })

    it('leaves the value undefined when neither name is set', async () => {
        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate().AP_JWT_SECRET).toBeUndefined()
    })

    it('warns once when a deprecated AP_ name is used without its QF_ counterpart', async () => {
        process.env.AP_JWT_SECRET = 'legacy-secret'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_JWT_SECRET') && message.includes('QF_JWT_SECRET'),
        )
        expect(deprecationWarnings).toHaveLength(1)
    })

    it('does not warn about AP_ when the QF_ counterpart is already set', async () => {
        process.env.AP_JWT_SECRET = 'legacy-secret'
        process.env.QF_JWT_SECRET = 'new-secret'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_JWT_SECRET'),
        )
        expect(deprecationWarnings).toHaveLength(0)
    })
})
