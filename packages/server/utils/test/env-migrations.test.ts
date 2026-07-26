import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS_UNDER_TEST = [
    'AP_JWT_SECRET',
    'QF_JWT_SECRET',
    'AP_ENCRYPTION_KEY',
    'QF_ENCRYPTION_KEY',
    'QF_SOME_UNKNOWN_PROP',
    'AP_SOME_UNKNOWN_PROP',
    'AP_DEV_QADAMS',
    'AP_DEV_PIECES',
    'QF_DEV_QADAMS',
    'QF_DEV_PIECES',
    'AP_CONTAINER_TYPE',
    'QF_CONTAINER_TYPE',
]

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
        process.env['AP_JWT_SECRET'] = 'legacy-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_JWT_SECRET']).toBe('legacy-secret')
    })

    it('resolves QF_ when only the new name is set', async () => {
        process.env['QF_JWT_SECRET'] = 'new-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_JWT_SECRET']).toBe('new-secret')
    })

    it('prefers QF_ over AP_ when both are set (deterministic precedence)', async () => {
        process.env['AP_JWT_SECRET'] = 'legacy-secret'
        process.env['QF_JWT_SECRET'] = 'new-secret'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_JWT_SECRET']).toBe('new-secret')
    })

    it('leaves the value undefined when neither name is set', async () => {
        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_JWT_SECRET']).toBeUndefined()
    })

    it('ignores an empty-string QF_ value instead of clobbering a valid AP_ value', async () => {
        process.env['AP_JWT_SECRET'] = 'legacy-secret'
        process.env['QF_JWT_SECRET'] = ''

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_JWT_SECRET']).toBe('legacy-secret')
    })

    it('warns once when a deprecated AP_ name is used without its QF_ counterpart', async () => {
        process.env['AP_ENCRYPTION_KEY'] = 'legacy-key'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_ENCRYPTION_KEY') && message.includes('QF_ENCRYPTION_KEY'),
        )
        expect(deprecationWarnings).toHaveLength(1)
    })

    it('does not warn about AP_ when the QF_ counterpart is already set', async () => {
        process.env['AP_ENCRYPTION_KEY'] = 'legacy-key'
        process.env['QF_ENCRYPTION_KEY'] = 'new-key'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_ENCRYPTION_KEY'),
        )
        expect(deprecationWarnings).toHaveLength(0)
    })

    it('still warns when the only QF_ counterpart present is an empty string', async () => {
        process.env['AP_ENCRYPTION_KEY'] = 'legacy-key'
        process.env['QF_ENCRYPTION_KEY'] = ''
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_ENCRYPTION_KEY') && message.includes('QF_ENCRYPTION_KEY'),
        )
        expect(deprecationWarnings).toHaveLength(1)
    })

    it('does not warn about AP_JWT_SECRET even without a QF_ counterpart (shell layer reads it first)', async () => {
        process.env['AP_JWT_SECRET'] = 'legacy-secret'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_JWT_SECRET'),
        )
        expect(deprecationWarnings).toHaveLength(0)
    })

    it('mirrors a QF_ name with no registered AP_ system prop the same generic way', async () => {
        process.env['QF_SOME_UNKNOWN_PROP'] = 'value'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_SOME_UNKNOWN_PROP']).toBe('value')
    })

    it('prefers a QF_ alias of the new piece name over a real AP_ value of the old (legacy) piece name', async () => {
        process.env['AP_DEV_PIECES'] = 'from-real-legacy-env-var'
        process.env['QF_DEV_QADAMS'] = 'from-qf-alias'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_DEV_QADAMS']).toBe('from-qf-alias')
    })

    it('resolves QF_ of the old piece name to the new piece name the downstream code reads', async () => {
        process.env['QF_DEV_PIECES'] = 'xyz'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_DEV_QADAMS']).toBe('xyz')
    })

    it('does not warn at all for a QF_-only alias of a legacy old piece name', async () => {
        process.env['QF_DEV_PIECES'] = 'xyz'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && (message.includes('AP_DEV_PIECES') || message.includes('AP_DEV_QADAMS')),
        )
        expect(deprecationWarnings).toHaveLength(0)
    })

    it('does not warn about shell-layer-only names that docker-entrypoint.sh/docker-compose.yml already set', async () => {
        process.env['AP_CONTAINER_TYPE'] = 'WORKER_AND_APP'
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        await import('../src/env-migrations')

        const deprecationWarnings = warnSpy.mock.calls.filter(([message]) =>
            typeof message === 'string' && message.includes('AP_CONTAINER_TYPE'),
        )
        expect(deprecationWarnings).toHaveLength(0)
    })

    it('still resolves QF_CONTAINER_TYPE even though it is exempt from the deprecation warning', async () => {
        process.env['QF_CONTAINER_TYPE'] = 'APP'

        const { environmentMigrations } = await import('../src/env-migrations')

        expect(environmentMigrations.migrate()['AP_CONTAINER_TYPE']).toBe('APP')
    })
})
