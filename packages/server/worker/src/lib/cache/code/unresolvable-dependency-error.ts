import { errorUtils } from '../../utils/errors'

// What `bun install` prints for a dependency that no retry can fix: a package the registry does not
// have, and a version nothing satisfies. An unreachable registry, or one that answers 5xx, prints
// neither, so that failure stays retryable (#584).
const UNRESOLVABLE_OUTPUT = [/ - 404\b/, /No version matching/]

/**
 * A code step's `package.json` names a dependency that cannot be installed. Retrying the run would
 * install the same `package.json` and fail the same way.
 */
export class UnresolvableDependencyError extends Error {
    constructor({ original }: { original: unknown }) {
        super(errorUtils.messageOf(original), { cause: original })
        this.name = 'UnresolvableDependencyError'
    }

    static isUnresolvable(error: unknown): boolean {
        return error instanceof Error && UNRESOLVABLE_OUTPUT.some((pattern) => pattern.test(error.message))
    }
}
