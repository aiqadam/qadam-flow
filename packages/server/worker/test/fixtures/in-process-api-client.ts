import { createRpcClient } from '@aiqadam/shared'
import type { WorkerToApiContract } from '@aiqadam/shared'

/**
 * The real RPC client over a socket that answers in-process, so a test gets a client typed as the
 * contract without a cast. A method the test does not provide answers `undefined`; one that throws
 * fails the call the way a real RPC does.
 */
export const inProcessApiClient = {
    create(methods: Partial<Record<keyof WorkerToApiContract, (input: unknown) => unknown>>): WorkerToApiContract {
        return createRpcClient<WorkerToApiContract>({
            emit: () => undefined,
            on: () => undefined,
            timeout: () => ({
                emitWithAck: async (_event: string, message: unknown) => {
                    if (!isRpcMessage(message)) {
                        throw new Error('not an RPC message')
                    }
                    const method = Object.entries(methods).find(([name]) => name === message.method)?.[1]
                    return method?.(message.payload)
                },
            }),
        }, 1_000)
    },
}

function isRpcMessage(value: unknown): value is { method: string, payload: unknown } {
    return typeof value === 'object' && value !== null && 'method' in value && typeof value.method === 'string'
}
