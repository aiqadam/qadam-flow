import { FastifyInstance } from 'fastify'
import { createTestContext, TestContext, TestContextParams } from './test-context'

// SERVICE (api-key) auth was removed with the EE purge and is unreachable in CE,
// so endpoints are only exercised under a USER principal here. Endpoints that
// still support a SERVICE principal are covered by dedicated per-test cases.
export function describeWithAuth(
    name: string,
    getApp: () => FastifyInstance,
    fn: (setup: () => Promise<TestContext>) => void,
    params?: TestContextParams,
): void {
    describe(`${name} [USER]`, () => {
        const setup = (): Promise<TestContext> => createTestContext(getApp(), params)
        fn(setup)
    })
}
