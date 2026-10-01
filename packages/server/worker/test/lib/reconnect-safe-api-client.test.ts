import { EngineResponseStatus } from '@aiqadam/shared'
import type { WorkerToApiContract } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'
import { reconnectSafeApiClient } from '../../src/lib/reconnect-safe-api-client'

/**
 * socket.io fails every acknowledgement still pending when the connection drops. A reconnect-safe
 * call that was in flight at the drop is therefore sent again, and every call, resent or new, waits
 * for the connection to be ready rather than for socket.io's buffer (#585).
 */
describe('reconnectSafeApiClient', () => {
    it('sends a completeJob again when the connection dropped while it was in flight', async () => {
        const connection = fakeConnection()
        const completeJob = vi.fn()
            .mockImplementationOnce(async () => {
                connection.disconnect()
                throw new Error('RPC [completeJob] failed (timeout: 60000ms): socket has been disconnected')
            })
            .mockResolvedValueOnce(undefined)
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ completeJob }), connection })

        await client.completeJob(completeJobInput())

        expect(completeJob).toHaveBeenCalledTimes(2)
        expect(completeJob.mock.calls[1][0]).toEqual(completeJobInput())
    })

    it('does not resend a call that failed on a live connection', async () => {
        const connection = fakeConnection()
        const completeJob = vi.fn().mockRejectedValue(new Error('RPC [completeJob] failed (timeout: 60000ms): operation has timed out'))
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ completeJob }), connection })

        await expect(client.completeJob(completeJobInput())).rejects.toThrow(/timed out/)
        expect(completeJob).toHaveBeenCalledTimes(1)
    })

    it('never resends a call that creates something', async () => {
        const connection = fakeConnection()
        const startInlineFlowRun = vi.fn().mockImplementation(async () => {
            connection.disconnect()
            throw new Error('socket has been disconnected')
        })
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ startInlineFlowRun }), connection })

        await expect(client.startInlineFlowRun({} as never)).rejects.toThrow(/disconnected/)
        expect(startInlineFlowRun).toHaveBeenCalledTimes(1)
        expect(reconnectSafeApiClient.safeMethods.has('poll'), 'the poll loop re-polls by itself').toBe(false)
    })

    it('gives up after a bounded number of dropped connections', async () => {
        const connection = fakeConnection()
        const updateRunProgress = vi.fn().mockImplementation(async () => {
            connection.disconnect()
            throw new Error('socket has been disconnected')
        })
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ updateRunProgress }), connection })

        await expect(client.updateRunProgress({} as never)).rejects.toThrow(/disconnected/)
        expect(updateRunProgress).toHaveBeenCalledTimes(reconnectSafeApiClient.maxAttempts)
    })

    // The reconnect renews every in-flight lease itself; a resent renewal that lands after the
    // worker gave a job up would extend a lock nobody runs under and delay the job's redelivery.
    it('does not resend a lease renewal', async () => {
        const connection = fakeConnection()
        const extendLock = vi.fn().mockImplementation(async () => {
            connection.disconnect()
            throw new Error('socket has been disconnected')
        })
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ extendLock }), connection })

        await expect(client.extendLock({ jobId: 'job-1', token: 'token-1', queueName: 'workerJobs' })).rejects.toThrow(/disconnected/)
        expect(extendLock).toHaveBeenCalledTimes(1)
    })

    // socket.io would buffer these and flush them on connect, before the API has attached its RPC
    // handlers to the new connection; nothing would ever acknowledge them.
    it('holds any call made while the connection is down until it is ready again', async () => {
        const connection = fakeConnection()
        const updateRunProgress = vi.fn().mockResolvedValue(undefined)
        const getFlowVersion = vi.fn().mockResolvedValue({ id: 'fv-1' })
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ updateRunProgress, getFlowVersion }), connection })
        connection.drop()

        const progress = client.updateRunProgress({} as never)
        const flowVersion = client.getFlowVersion({} as never)
        await flushMicrotasks()
        expect(updateRunProgress).not.toHaveBeenCalled()
        expect(getFlowVersion).not.toHaveBeenCalled()

        connection.restore()
        await expect(progress).resolves.toBeUndefined()
        await expect(flowVersion).resolves.toEqual({ id: 'fv-1' })
        expect(updateRunProgress).toHaveBeenCalledTimes(1)
        expect(getFlowVersion).toHaveBeenCalledTimes(1)
    })

    it('resends a dropped call only once the connection is ready again', async () => {
        const connection = fakeConnection()
        const completeJob = vi.fn()
            .mockImplementationOnce(async () => {
                connection.drop()
                throw new Error('RPC [completeJob] failed (timeout: 60000ms): socket has been disconnected')
            })
            .mockResolvedValueOnce(undefined)
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ completeJob }), connection })

        const completion = client.completeJob(completeJobInput())
        await flushMicrotasks()
        expect(completeJob).toHaveBeenCalledTimes(1)

        connection.restore()
        await completion
        expect(completeJob).toHaveBeenCalledTimes(2)
    })

    it('fails a call whose connection is not ready within the RPC budget, without sending it', async () => {
        vi.useFakeTimers()
        try {
            const connection = fakeConnection()
            const updateRunProgress = vi.fn().mockResolvedValue(undefined)
            const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ updateRunProgress }), connection })
            connection.drop()

            const progress = client.updateRunProgress({} as never)
            const assertion = expect(progress).rejects.toThrow(/not ready/)
            await vi.advanceTimersByTimeAsync(reconnectSafeApiClient.readyTimeoutMs)
            await assertion
            expect(updateRunProgress).not.toHaveBeenCalled()
            expect(connection.waiterCount(), 'a call that stopped waiting left its waiter behind').toBe(0)
        }
        finally {
            vi.useRealTimers()
        }
    })

    it('returns what the API answered', async () => {
        const connection = fakeConnection()
        const getFlowVersion = vi.fn().mockResolvedValue({ id: 'fv-1' })
        const client = reconnectSafeApiClient.wrap({ apiClient: fakeApiClient({ getFlowVersion }), connection })

        await expect(client.getFlowVersion({} as never)).resolves.toEqual({ id: 'fv-1' })
    })
})

function fakeConnection(): FakeConnection {
    let generation = 0
    let ready = true
    let waiters: (() => void)[] = []
    return {
        generation: () => generation,
        isReady: () => ready,
        whenReady: ({ signal }) => ready ? Promise.resolve() : new Promise<void>((resolve) => {
            const release = (): void => {
                waiters = waiters.filter((waiter) => waiter !== release)
                resolve()
            }
            waiters = [...waiters, release]
            signal.addEventListener('abort', release, { once: true })
        }),
        waiterCount: () => waiters.length,
        disconnect: (): void => {
            generation++
        },
        drop: (): void => {
            generation++
            ready = false
        },
        restore: (): void => {
            ready = true
            const released = waiters
            waiters = []
            released.forEach((release) => release())
        },
    }
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve()
    }
}

function fakeApiClient(methods: Partial<Record<keyof WorkerToApiContract, unknown>>): WorkerToApiContract {
    return methods as unknown as WorkerToApiContract
}

function completeJobInput(): Parameters<WorkerToApiContract['completeJob']>[0] {
    return { jobId: 'job-1', token: 'token-1', queueName: 'workerJobs', status: EngineResponseStatus.OK }
}

type FakeConnection = {
    generation: () => number
    isReady: () => boolean
    whenReady: (params: { signal: AbortSignal }) => Promise<void>
    waiterCount: () => number
    /** A disconnect whose reconnect is already done by the time the call is resent. */
    disconnect: () => void
    /** A disconnect that stays down until `restore()`. */
    drop: () => void
    restore: () => void
}
