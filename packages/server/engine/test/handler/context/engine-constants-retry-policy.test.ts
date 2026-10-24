import { retryingFetch } from '../../../src/lib/retrying-fetch'
import { generateMockEngineConstants } from '../test-helper'

// #604: every retrying engine→app call this operation makes shares its own `timeoutInSeconds`
// deadline, so a trigger/property/validation hook (60 s default) or a loop checkpoint whose own
// margin is itself ≥ 60 s gives up cleanly before the worker's killProcess fires.
describe('EngineConstants retry policy (#604)', () => {
    it('caps the default policy to a short operation\'s own remaining deadline', () => {
        const constants = generateMockEngineConstants({ timeoutInSeconds: 10 })

        const policy = constants.retryPolicy()

        expect(policy.budgetMs).toBeLessThan(retryingFetch.defaultPolicy.budgetMs)
        expect(policy.budgetMs).toBeGreaterThan(0)
    })

    it('leaves a long operation\'s policy unchanged', () => {
        const constants = generateMockEngineConstants({ timeoutInSeconds: 3600 })

        const policy = constants.retryPolicy()

        expect(policy.budgetMs).toBe(retryingFetch.defaultPolicy.budgetMs)
    })

    it('caps whatever policy is passed in, not just the default', () => {
        const constants = generateMockEngineConstants({ timeoutInSeconds: 10 })

        const policy = constants.retryPolicy(retryingFetch.bestEffortPolicy)

        expect(policy.budgetMs).toBeLessThanOrEqual(retryingFetch.bestEffortPolicy.budgetMs)
    })

    it('floors the budget at 0 once the operation\'s own deadline has already passed', () => {
        const constants = generateMockEngineConstants({ timeoutInSeconds: 1, executionStartedAt: Date.now() - 10_000 })

        const policy = constants.retryPolicy()

        expect(policy.budgetMs).toBe(0)
    })

    it('remainingTimeoutMs reports what is left of the operation\'s own deadline', () => {
        const constants = generateMockEngineConstants({ timeoutInSeconds: 60, executionStartedAt: Date.now() - 10_000 })

        const remaining = constants.remainingTimeoutMs()

        expect(remaining).toBeGreaterThan(40_000)
        expect(remaining).toBeLessThanOrEqual(50_000)
    })

    it('an inline child shares its parent\'s deadline, so its own retry policy is capped the same way', () => {
        const parent = generateMockEngineConstants({ timeoutInSeconds: 10 })
        const child = generateMockEngineConstants({ timeoutInSeconds: parent.timeoutInSeconds, executionStartedAt: parent.executionStartedAt })

        expect(child.retryPolicy().budgetMs).toBe(parent.retryPolicy().budgetMs)
    })
})
