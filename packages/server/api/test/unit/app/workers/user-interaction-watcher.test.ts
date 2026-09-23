import { ErrorCode, PackageType, QadamFlowError, QadamType, UserInteractionJobDataWithoutWatchingInformation, WorkerJobType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLog: FastifyBaseLogger = {
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

const oneTimeListenerMock = vi.fn()
const getServerIdMock = vi.fn().mockReturnValue('server-1')

vi.mock('../../../../src/app/workers/engine-response-watcher', () => ({
    engineResponseWatcher: () => ({
        getServerId: getServerIdMock,
        oneTimeListener: oneTimeListenerMock,
    }),
}))

const addMock = vi.fn()

vi.mock('../../../../src/app/workers/job-queue/job-queue', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/workers/job-queue/job-queue')>()
    return {
        ...actual,
        jobQueue: () => ({ add: addMock }),
    }
})

import { userInteractionWatcher } from '../../../../src/app/workers/user-interaction-watcher'

const mockRequest: UserInteractionJobDataWithoutWatchingInformation = {
    jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
    projectId: undefined,
    platformId: 'platform-1',
    qadam: {
        packageType: PackageType.REGISTRY,
        qadamType: QadamType.OFFICIAL,
        qadamName: 'test-qadam',
        qadamVersion: '1.0.0',
    },
}

describe('userInteractionWatcher#submitAndWaitForResponse', () => {
    let cancelMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.clearAllMocks()
        getServerIdMock.mockReturnValue('server-1')
        cancelMock = vi.fn()
    })

    it('registers the listener before enqueueing the job, so an immediate engine response is not dropped', async () => {
        const callOrder: string[] = []
        oneTimeListenerMock.mockImplementation(() => {
            callOrder.push('listen')
            return { promise: Promise.resolve({ ok: true }), cancel: cancelMock }
        })
        addMock.mockImplementation(async () => {
            callOrder.push('enqueue')
            return null
        })

        const result = await userInteractionWatcher.submitAndWaitForResponse<{ ok: boolean }>(mockRequest, mockLog)

        expect(result).toEqual({ ok: true })
        // #526: the listener must be registered before the job is enqueued — otherwise a worker
        // response published the instant the job is added reaches no one, and the caller waits
        // out the full safety timeout instead.
        expect(callOrder).toEqual(['listen', 'enqueue'])
        expect(oneTimeListenerMock).toHaveBeenCalledTimes(1)
        expect(addMock).toHaveBeenCalledTimes(1)

        // A regression that mints a second apId() for the enqueued job (instead of reusing the
        // id the listener was registered under) would still pass the ordering assertion above —
        // it would just mean the worker's response never finds this listener's key. Pin the two
        // ids to be the exact same value.
        const listenerKey = oneTimeListenerMock.mock.calls[0][0]
        expect(addMock.mock.calls[0][0]).toMatchObject({ id: listenerKey, data: { requestId: listenerKey } })
    })

    it('rejects with ENGINE_OPERATION_FAILURE when the listener settles with no response, instead of an unexplained undefined', async () => {
        oneTimeListenerMock.mockImplementation(() => ({
            promise: Promise.resolve(undefined),
            cancel: cancelMock,
        }))
        addMock.mockResolvedValue(null)

        const error = await userInteractionWatcher.submitAndWaitForResponse(mockRequest, mockLog).catch((caught: unknown) => caught)

        expect(error).toBeInstanceOf(QadamFlowError)
        if (error instanceof QadamFlowError) {
            expect(error.error.code).toBe(ErrorCode.ENGINE_OPERATION_FAILURE)
        }
    })

    it('cancels the listener when enqueueing the job fails, instead of leaving it to expire on the safety timeout', async () => {
        oneTimeListenerMock.mockImplementation(() => ({
            promise: new Promise(() => {
                // Never resolves on its own; only cancel() (asserted below) settles it, the
                // same way the real listener only settles on response, timeout, or cancel.
            }),
            cancel: cancelMock,
        }))
        const enqueueError = new Error('enqueue boom')
        addMock.mockRejectedValueOnce(enqueueError)

        await expect(userInteractionWatcher.submitAndWaitForResponse(mockRequest, mockLog))
            .rejects.toThrow('enqueue boom')

        expect(cancelMock).toHaveBeenCalledTimes(1)
        expect(oneTimeListenerMock).toHaveBeenCalledTimes(1)
        expect(addMock).toHaveBeenCalledTimes(1)
    })
})
