import { describe, expect, it } from 'vitest'
import { UnresolvableDependencyError } from '../../../src/lib/cache/code/unresolvable-dependency-error'

// The output below is what `bun install` 1.3 printed for each case, through spawnWithKill's
// `Exit <code>\nstdout: ...\nstderr: ...` message.
function bunInstallFailure(stderr: string): Error {
    return new Error(`Exit 1\nstdout: bun install v1.3.14\nstderr: ${stderr}`)
}

describe('UnresolvableDependencyError (#584)', () => {
    it('recognises a package the registry does not have', () => {
        const error = bunInstallFailure('error: GET https://registry.npmjs.org/no-such-package - 404\nerror: no-such-package@1.0.0 failed to resolve')

        expect(UnresolvableDependencyError.isUnresolvable(error)).toBe(true)
    })

    it('recognises a version nothing satisfies', () => {
        const error = bunInstallFailure('error: No version matching "99.99.99" found for specifier "lodash" (but package exists)\nerror: lodash@99.99.99 failed to resolve')

        expect(UnresolvableDependencyError.isUnresolvable(error)).toBe(true)
    })

    it('leaves an unreachable registry retryable, although bun says "failed to resolve" for it too', () => {
        const error = bunInstallFailure('error: ConnectionRefused downloading package manifest left-pad\nerror: left-pad@1.3.0 failed to resolve')

        expect(UnresolvableDependencyError.isUnresolvable(error)).toBe(false)
    })

    it('leaves a timed-out install retryable', () => {
        expect(UnresolvableDependencyError.isUnresolvable(new Error('Timeout after 600000ms\nstdout: \nstderr: '))).toBe(false)
    })

    it('keeps the original message, which carries the install output', () => {
        const original = bunInstallFailure('error: GET https://registry.npmjs.org/no-such-package - 404')

        const error = new UnresolvableDependencyError({ original })

        expect(error.message).toBe(original.message)
        expect(error.original).toBe(original)
    })
})
