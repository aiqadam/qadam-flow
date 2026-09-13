import { ExecutionError, ExecutionErrorType } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVariableResolver } from '../../src/lib/qadam-context/variable-resolver'

const resolver = createVariableResolver({
    projectId: 'PROJECT_ID',
    engineToken: 'WORKER_TOKEN',
    apiUrl: 'http://127.0.0.1:3000/',
})

async function obtainError(name: string): Promise<ExecutionError> {
    try {
        await resolver.obtain(name)
    }
    catch (error) {
        if (error instanceof ExecutionError) {
            return error
        }
        throw error
    }
    throw new Error(`expected obtain("${name}") to reject`)
}

function stubFetch(status: number, body: unknown = {}): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    })))
}

describe('variable resolver', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('returns the value when the variable exists', async () => {
        stubFetch(200, { value: 'secret' })

        await expect(resolver.obtain('SIGNING_KEY')).resolves.toBe('secret')
    })

    // #392: a name that does not exist is an authoring mistake. Reported as ENGINE it escaped every
    // step handler and failed the run as INTERNAL_ERROR with no step list.
    it('reports a missing variable as a USER error naming the variable', async () => {
        stubFetch(404)

        const error = await obtainError('NONEXISTENT')

        expect(error.type).toBe(ExecutionErrorType.USER)
        expect(error.message).toContain('NONEXISTENT')
    })

    it('keeps a server-side failure an ENGINE error', async () => {
        stubFetch(500)

        const error = await obtainError('SIGNING_KEY')

        expect(error.type).toBe(ExecutionErrorType.ENGINE)
    })
})
