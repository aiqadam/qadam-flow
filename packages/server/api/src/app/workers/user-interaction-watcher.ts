import { apId, ErrorCode, isNil, LATEST_JOB_DATA_SCHEMA_VERSION, QadamFlowError, tryCatch, UserInteractionJobDataWithoutWatchingInformation } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { engineResponseWatcher } from './engine-response-watcher'
import { jobQueue, JobType } from './job-queue/job-queue'

const WATCHER_SAFETY_TIMEOUT_MS = 5 * 60 * 1000

export const userInteractionWatcher = {
    submitAndWaitForResponse: async <T>(request: UserInteractionJobDataWithoutWatchingInformation, log: FastifyBaseLogger): Promise<T> => {
        const id = apId()
        // Register the listener before enqueueing the job: the worker can respond as soon as the
        // job is added, and if that happens before oneTimeListener runs, the response reaches no
        // one and the caller waits out the full safety timeout. The returned cancel() is bound to
        // this exact registration, so a failed enqueue can tear it down without risking another
        // request's listener (see engineResponseWatcher#oneTimeListener).
        const listener = engineResponseWatcher(log).oneTimeListener<T | undefined>(id, true, WATCHER_SAFETY_TIMEOUT_MS, undefined)
        const { error } = await tryCatch(() => jobQueue(log).add({
            id,
            type: JobType.ONE_TIME,
            data: {
                ...request,
                requestId: id,
                webserverId: engineResponseWatcher(log).getServerId(),
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            },
        }))
        if (error) {
            listener.cancel()
            throw error
        }
        const result = await listener.promise
        if (isNil(result)) {
            throw new QadamFlowError({
                code: ErrorCode.ENGINE_OPERATION_FAILURE,
                params: { message: 'Worker did not respond within the safety timeout' },
            })
        }
        return result
    },
}
