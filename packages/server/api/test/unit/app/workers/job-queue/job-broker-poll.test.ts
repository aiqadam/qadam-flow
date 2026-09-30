import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

const dispatcherPoll = vi.fn().mockResolvedValue(null)

vi.mock('bullmq', async (importOriginal) => {
    const actual = await importOriginal<typeof import('bullmq')>()
    class FakeWorker {
        waitUntilReady = vi.fn().mockResolvedValue(undefined)
        startStalledCheckTimer = vi.fn().mockResolvedValue(undefined)
        on = vi.fn()
        close = vi.fn().mockResolvedValue(undefined)
    }
    return { ...actual, Worker: FakeWorker }
})

vi.mock('../../../../../src/app/database/redis-connections', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../../src/app/database/redis-connections')>()
    return { ...actual, redisConnections: { ...actual.redisConnections, create: vi.fn().mockResolvedValue({}) } }
})

vi.mock('../../../../../src/app/workers/job-queue/queue-dispatcher', () => ({
    createQueueDispatcher: () => ({ poll: dispatcherPoll, close: vi.fn(), waiterCount: () => 0 }),
}))

import { jobBroker } from '../../../../../src/app/workers/job-queue/job-broker'

const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

describe('jobBroker#poll (#589)', () => {
    // The socket's signal is what lets the dispatcher drop a disconnected worker's poll; losing it
    // on the way down would silently bring the ~139 s redelivery back.
    it('forwards the socket signal to the dispatcher', async () => {
        const socket = new AbortController()

        await jobBroker(log).poll({ queueName: 'workerJobs', signal: socket.signal })

        expect(dispatcherPoll).toHaveBeenCalledWith({ signal: socket.signal })
    })
})
