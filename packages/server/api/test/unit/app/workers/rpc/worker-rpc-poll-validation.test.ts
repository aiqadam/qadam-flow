import { apVersionUtil } from '@aiqadam/server-utils'
import { MachineInformation } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const onConnection = vi.fn().mockResolvedValue({})
const poll = vi.fn().mockResolvedValue(null)
const returnToQueue = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../../../src/app/workers/machine/machine-service', () => ({
    machineService: () => ({ onConnection }),
}))

vi.mock('../../../../../src/app/workers/job-queue/job-broker', () => ({
    jobBroker: () => ({ poll, returnToQueue }),
}))

import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'

function currentVersion(): string {
    return apVersionUtil.getCurrentRelease()
}

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

const machineInfo: MachineInformation = {
    workerId: 'worker-1',
    cpuUsagePercentage: 1,
    ramUsagePercentage: 2,
    totalAvailableRamInBytes: 8,
    totalCpuCores: 1,
    ip: '10.0.0.1',
    workerProps: { version: 'some-other-version' },
    sandboxes: [],
    diskInfo: { total: 10, free: 5, used: 5, percentage: 50 },
}

describe('workerRpc#poll healthcheck validation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    // Malformed telemetry must not reach the registry — it is rendered in the admin table — but
    // it must not stop the worker doing its job either: these are fields the worker does not
    // choose. So the registry update is skipped and polling continues. The version gate below is
    // what still has to hold, and it is read separately for exactly that reason.
    it('skips the registry update for a malformed payload but keeps polling', async () => {
        const handlers = createHandlers({ log, disconnected: new AbortController().signal })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await handlers.poll({ ...machineInfo, ip: 42, workerProps: { version: currentVersion() } } as any)

        expect(onConnection).not.toHaveBeenCalled()
        expect(poll).toHaveBeenCalledTimes(1)
        expect(result).toBeNull()
    })

    // The one thing a malformed payload must NOT buy: a way around the version gate. An
    // unreadable version counts as a mismatch, not as a match.
    it('withholds the job when the version cannot be read from a malformed payload', async () => {
        const handlers = createHandlers({ log, disconnected: new AbortController().signal })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await handlers.poll({ ...machineInfo, ip: 42, workerProps: { version: 42 } } as any)

        expect(result).toBeNull()
        expect(poll).not.toHaveBeenCalled()
    })

    it('stores a well-formed payload against the group bound to the token', async () => {
        const handlers = createHandlers({ log, workerGroupId: 'group-a', disconnected: new AbortController().signal })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handlers.poll({ ...machineInfo, unexpectedField: 'dropped' } as any)

        expect(onConnection).toHaveBeenCalledWith(machineInfo, 'group-a')
    })
})

describe('workerRpc#poll on a socket that disconnected (#589)', () => {
    const job = {
        jobId: 'job-1',
        jobData: { jobType: 'EXECUTE_FLOW' },
        attempsStarted: 0,
        engineToken: 'engine-token',
        token: 'lock-token',
        queueName: 'workerJobs',
    }
    const livePayload = { ...machineInfo, workerProps: { version: currentVersion() } }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('ties the dispatcher poll to the socket', async () => {
        const socket = new AbortController()
        poll.mockResolvedValueOnce(job)

        const result = await createHandlers({ log, disconnected: socket.signal }).poll(livePayload)

        expect(poll).toHaveBeenCalledWith(expect.objectContaining({ signal: socket.signal }))
        expect(result).toEqual(job)
        expect(returnToQueue).not.toHaveBeenCalled()
    })

    it('returns a job handed out as the socket closed to the queue instead of acking it', async () => {
        const socket = new AbortController()
        poll.mockImplementationOnce(async () => {
            socket.abort()
            return job
        })

        const result = await createHandlers({ log, disconnected: socket.signal }).poll(livePayload)

        expect(result).toBeNull()
        expect(returnToQueue).toHaveBeenCalledWith(job)
    })

    it('still answers null and logs when returning the job fails', async () => {
        const socket = new AbortController()
        poll.mockImplementationOnce(async () => {
            socket.abort()
            return job
        })
        returnToQueue.mockRejectedValueOnce(new Error('redis down'))

        const result = await createHandlers({ log, disconnected: socket.signal }).poll(livePayload)

        expect(result).toBeNull()
        expect(log.error).toHaveBeenCalledWith(
            expect.objectContaining({ jobId: 'job-1', error: 'Error: redis down' }),
            '[workerRpc#poll] Failed to return the job of a disconnected worker to the queue',
        )
    })

    it('neither re-registers the worker nor polls once the socket is gone', async () => {
        const socket = new AbortController()
        socket.abort()

        const result = await createHandlers({ log, disconnected: socket.signal }).poll(livePayload)

        expect(result).toBeNull()
        expect(onConnection).not.toHaveBeenCalled()
        expect(poll).not.toHaveBeenCalled()
    })

    it('returns nothing to the queue when the dropped poll had no job', async () => {
        const socket = new AbortController()
        poll.mockImplementationOnce(async () => {
            socket.abort()
            return null
        })

        const result = await createHandlers({ log, disconnected: socket.signal }).poll(livePayload)

        expect(result).toBeNull()
        expect(returnToQueue).not.toHaveBeenCalled()
    })
})
