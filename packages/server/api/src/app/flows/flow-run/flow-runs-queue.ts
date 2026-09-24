import { FileType, FlowRun, FlowRunStatus, isFlowRunStateTerminal, isNil, spreadIfDefined, tryCatch } from '@aiqadam/shared'
import { Job, Queue, Worker } from 'bullmq'
import { BullMQOtel } from 'bullmq-otel'
import { FastifyBaseLogger } from 'fastify'
import { QueryFailedError } from 'typeorm'
import { distributedLock, distributedStore, redisConnections } from '../../database/redis-connections'
import { fileService } from '../../file/file.service'
import { domainHelper } from '../../helper/domain-helper'
import { exceptionHandler } from '../../helper/exception-handler'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { QueueName, redisMetadataKey, RunsMetadataJobData, RunsMetadataQueueConfig, runsMetadataQueueFactory, RunsMetadataUpsertData } from '../../workers/job'
import { flowService } from '../flow/flow.service'
import { flowRunRepo } from './flow-run-service'
import { flowRunSideEffects } from './flow-run-side-effects'
import { joinWaitpointService } from './waitpoint/join-waitpoint-service'
import { resumeService } from './waitpoint/resume-service'
import { waitpointService } from './waitpoint/waitpoint-service'
import { WaitpointStatus } from './waitpoint/waitpoint-types'

let runsMetadataWorker: Worker<RunsMetadataJobData> | undefined = undefined

const queue = runsMetadataQueueFactory({ createRedisConnection: redisConnections.create, distributedStore })

export const runsMetadataQueue = (log: FastifyBaseLogger) => ({
    async init(): Promise<void> {
        const queueName = QueueName.RUNS_METADATA
        const isOtelEnabled = system.getBoolean(AppSystemProp.OTEL_ENABLED) ?? false

        const config: RunsMetadataQueueConfig = {
            isOtelEnabled,
            redisFailedJobRetentionDays: system.getNumberOrThrow(AppSystemProp.REDIS_FAILED_JOB_RETENTION_DAYS),
            redisFailedJobRetentionMaxCount: system.getNumberOrThrow(AppSystemProp.REDIS_FAILED_JOB_RETENTION_MAX_COUNT),
        }
        await queue.init(config)
        runsMetadataWorker = new Worker<RunsMetadataJobData>(
            queueName,
            async (job) => {
                log.info({
                    jobId: job.id,
                    runId: job.data.runId,
                }, '[runsMetadataQueue#worker] Saving runs metadata')
                const key = redisMetadataKey(job.data.runId)
                await distributedLock(log).runExclusive({
                    key: `runs_metadata_${job.data.runId}`,
                    timeoutInSeconds: 30,
                    fn: async () => {
                        try {
                            await drainRunsMetadataUpdates({ log, job, key })
                            // Released only after the updates are durably stored: uploads that
                            // merged into the hash while this job was active are picked up by
                            // the drain loop instead of fanning out into duplicate jobs.
                            // (BullMQ also clears the key on finalization; this covers the
                            // success path explicitly. It is deliberately not cleared on
                            // failure, so uploads during the retry backoff coalesce into the
                            // pending retry, which re-reads the hash.)
                            await runsMetadataQueue(log).get().removeDeduplicationKey(job.data.runId)
                            await reenqueueWhenUpdatesArrivedLate({ log, job, key })
                        }
                        catch (error) {
                            log.error({
                                error,
                                data: job.data,
                            }, '[runsMetadataQueue#worker] Error saving runs metadata')
                            exceptionHandler.handle(error, log)
                            throw error
                        }
                    },
                })

            },
            {
                connection: await redisConnections.create(),
                telemetry: isOtelEnabled ? new BullMQOtel(queueName) : undefined,
                concurrency: system.getNumberOrThrow(AppSystemProp.RUNS_METADATA_UPDATE_CONCURRENCY),
                autorun: true,
            },
        )

        await runsMetadataWorker.waitUntilReady()
    },

    async add(params: RunsMetadataUpsertData): Promise<void> {
        log.info({
            runId: params.id,
            projectId: params.projectId,
        }, '[runsMetadataQueue#add] Adding runs metadata to queue')
        await queue.add(params)
    },

    get(): Queue<RunsMetadataJobData> {
        return queue.get()
    },
    async close(): Promise<void> {
        if (queue.get()) {
            await queue.get().close()
        }

        if (runsMetadataWorker) {
            await runsMetadataWorker.close()
        }
    },

})

const MAX_DRAIN_ITERATIONS = 10

async function drainRunsMetadataUpdates({ log, job, key }: DrainRunsMetadataParams): Promise<void> {
    for (let iteration = 0; iteration < MAX_DRAIN_ITERATIONS; iteration++) {
        const processed = await processRunsMetadataUpdate({ log, job, key })
        if (!processed) {
            return
        }
    }
}

async function reenqueueWhenUpdatesArrivedLate({ log, job, key }: DrainRunsMetadataParams): Promise<void> {
    const leftover = await distributedStore.hgetJson<RunsMetadataUpsertData>(key)
    if (isNil(leftover) || Object.keys(leftover).length === 0) {
        return
    }
    // Merged after the final drain read while this job was still active, so no job
    // remains to consume it. Re-enqueued without merging: the hash already holds the
    // fresh fields, and re-merging a stale snapshot would clobber them.
    log.info({
        jobId: job.id,
        runId: job.data.runId,
    }, '[runsMetadataQueue#worker] Updates arrived during finalization, re-enqueueing')
    await runsMetadataQueue(log).get().add(
        'update-run-metadata',
        { runId: job.data.runId, projectId: job.data.projectId },
        { deduplication: { id: job.data.runId } },
    )
}

async function processRunsMetadataUpdate({ log, job, key }: DrainRunsMetadataParams): Promise<boolean> {
    const runMetadata = await distributedStore.hgetJson<RunsMetadataUpsertData>(key)
    if (isNil(runMetadata) || Object.keys(runMetadata).length === 0) {
        log.info({
            jobId: job.id,
            runId: job.data.runId,
        }, '[runsMetadataQueue#worker] Runs metadata not found, skipping job')
        return false
    }

    const projectId = runMetadata.projectId
    if (isNil(projectId)) {
        // TypeORM drops an undefined criterion from a find rather than matching on it, so the
        // lookups below would read the run by id alone, whichever project owns it, and carry that
        // row into the finish side effects.
        log.warn({
            jobId: job.id,
            runId: job.data.runId,
        }, '[runsMetadataQueue#worker] Runs metadata carries no projectId, dropping it')
        await consumeProcessedMetadata({ key, runMetadata })
        return false
    }
    const logsFileId = await resolveWritableLogsFileId({ log, job, projectId, runMetadata })
    const existingFlowRun = await flowRunRepo().findOneBy({ id: job.data.runId, projectId })
    let savedFlowRun: FlowRun
    if (!isNil(existingFlowRun)) {
        await updateFlowRunIgnoringDanglingLogsFile({ runId: job.data.runId, projectId, runMetadata, logsFileId, log, job })
        const updatedFlowRun = await flowRunRepo().findOneBy({ id: job.data.runId, projectId })
        if (isNil(updatedFlowRun)) {
            log.info({
                jobId: job.id,
                runId: job.data.runId,
            }, '[runsMetadataQueue#worker] Flow run was deleted during update, skipping job')
            await consumeProcessedMetadata({ key, runMetadata })
            return false
        }
        savedFlowRun = updatedFlowRun
    }
    else {
        // Deliberately unscoped: the run id is the table's primary key, so this asks whether the id
        // is taken at all. If it is, the row belongs to another project, and `save` below would
        // upsert it — rewriting that project's run, its projectId included, from metadata that does
        // not speak for it (#512).
        const claimedByAnotherProject = await flowRunRepo().existsBy({ id: job.data.runId })
        if (claimedByAnotherProject) {
            log.warn({
                jobId: job.id,
                runId: job.data.runId,
                projectId,
            }, '[runsMetadataQueue#worker] Run belongs to another project, dropping its metadata')
            await consumeProcessedMetadata({ key, runMetadata })
            return false
        }
        const flowId = runMetadata.flowId
        const flowExists = !isNil(flowId) && await flowService(log).exists({ id: flowId, projectId })
        if (!flowExists) {
            log.info({
                jobId: job.id,
                runId: job.data.runId,
            }, '[runsMetadataQueue#worker] Flow does not exist in the run\'s project (deleted?), skipping job')
            await consumeProcessedMetadata({ key, runMetadata })
            return false
        }
        savedFlowRun = await flowRunRepo().save({
            ...runMetadata,
            logsFileId: logsFileId ?? null,
        })
    }

    const parentRunId = savedFlowRun.parentRunId
    const answersJoinSlot = !isNil(savedFlowRun.parentSlotId)
    // A join child (#374) answers its own slot on any terminal status — including a SUCCEEDED run
    // that never reached a Return Response — and never completes the parent's waitpoint itself.
    if (answersJoinSlot && isFlowRunStateTerminal({ status: savedFlowRun.status, ignoreInternalError: false })) {
        await joinWaitpointService(log).fillSlotForFinishedChild({ childRun: savedFlowRun })
    }
    const shouldMarkParentAsFailed = !answersJoinSlot && savedFlowRun.failParentOnFailure && !isNil(parentRunId) && ![FlowRunStatus.SUCCEEDED, FlowRunStatus.RUNNING, FlowRunStatus.PAUSED, FlowRunStatus.QUEUED].includes(savedFlowRun.status)
    if (shouldMarkParentAsFailed) {
        await markParentRunAsFailed({
            parentRunId,
            parentWaitpointId: savedFlowRun.parentWaitpointId,
            childRunId: savedFlowRun.id,
            projectId: savedFlowRun.projectId,
            log,
        })
    }

    await consumeProcessedMetadata({ key, runMetadata })
    if (!isNil(runMetadata.finishTime)) {
        await flowRunSideEffects(log).onFinish(savedFlowRun)
    }

    if (savedFlowRun.status === FlowRunStatus.PAUSED) {
        const latestWaitpoint = await waitpointService(log).getByFlowRunId({ flowRunId: savedFlowRun.id, projectId: savedFlowRun.projectId })
        const isPreCompleted = !isNil(latestWaitpoint)
            && latestWaitpoint.status === WaitpointStatus.COMPLETED
        if (isPreCompleted) {
            await resumeService(log).resumeFromWaitpoint({
                flowRunId: savedFlowRun.id,
                waitpointId: latestWaitpoint.id,
                resumePayload: latestWaitpoint.resumePayload,
            })
        }
    }
    return true
}

/**
 * Consumes the snapshot this job just processed, so the drain loop and
 * `reenqueueWhenUpdatesArrivedLate` see an empty hash and stop.
 *
 * Conditional on `requestId` so an update merged while this job was working survives and gets its
 * own pass; without a version marker to compare against, the payload just processed cannot be told
 * apart from a fresh one on the next drain read, so it is dropped outright — leaving it would
 * reprocess the same update up to MAX_DRAIN_ITERATIONS and then re-enqueue a job that does it all
 * over again.
 *
 * Every path that finishes with a snapshot must call this, including the ones that abandon it.
 * The two "the flow is gone" paths used to return without consuming anything, and that is a
 * permanent hot loop, not a leak that drains later: the hash stays non-empty, so the re-enqueue at
 * the end of the job adds another job, which abandons it again, forever. Measured at ~200k job
 * invocations in 25 minutes across a single CE suite run, one runId accounting for 18,814 of them,
 * with the churn outliving the test file that created it (#500).
 */
async function consumeProcessedMetadata({ key, runMetadata }: ConsumeProcessedMetadataParams): Promise<void> {
    if (!isNil(runMetadata.requestId)) {
        await distributedStore.deleteKeyIfFieldValueMatches(key, 'requestId', runMetadata.requestId)
        return
    }
    await distributedStore.delete(key)
}

async function resolveWritableLogsFileId({ log, job, projectId, runMetadata }: ResolveWritableLogsFileIdParams): Promise<string | undefined> {
    if (isNil(runMetadata.logsFileId)) {
        return undefined
    }
    const exists = await fileService(log).exists({
        projectId,
        fileId: runMetadata.logsFileId,
        type: FileType.FLOW_RUN_LOG,
    })
    if (exists) {
        return runMetadata.logsFileId
    }
    // A logsFileId whose file was never written must not discard the status write.
    log.warn({
        runId: job.data.runId,
        logsFileId: runMetadata.logsFileId,
    }, '[runsMetadataQueue#worker] Logs file not found, saving run status without it')
    return undefined
}

async function updateFlowRunIgnoringDanglingLogsFile({ runId, projectId, runMetadata, logsFileId, log, job }: UpdateFlowRunParams): Promise<void> {
    const { error } = await tryCatch(() => flowRunRepo().update({ id: runId, projectId }, buildFlowRunUpdate({ runMetadata, logsFileId })))
    if (isNil(error)) {
        return
    }
    if (!isNil(logsFileId) && isLogsFileForeignKeyViolation(error)) {
        // The file vanished between the existence check and the write; status and
        // finishTime matter more than the log pointer.
        log.warn({
            runId: job.data.runId,
            logsFileId,
        }, '[runsMetadataQueue#worker] Logs file gone mid-write, retrying status update without it')
        await flowRunRepo().update({ id: runId, projectId }, buildFlowRunUpdate({ runMetadata, logsFileId: undefined }))
        return
    }
    throw error
}

// No projectId: the row was matched on it, and a run never changes project.
function buildFlowRunUpdate({ runMetadata, logsFileId }: BuildFlowRunUpdateParams) {
    return {
        ...spreadIfDefined('flowId', runMetadata.flowId),
        ...spreadIfDefined('flowVersionId', runMetadata.flowVersionId),
        ...spreadIfDefined('environment', runMetadata.environment),
        ...spreadIfDefined('startTime', runMetadata.startTime),
        ...spreadIfDefined('finishTime', runMetadata.finishTime),
        ...spreadIfDefined('status', runMetadata.status),
        ...spreadIfDefined('tags', runMetadata.tags),
        ...spreadIfDefined('failedStep', runMetadata.failedStep),
        ...spreadIfDefined('stepNameToTest', runMetadata.stepNameToTest),
        ...spreadIfDefined('parentRunId', runMetadata.parentRunId),
        ...spreadIfDefined('failParentOnFailure', runMetadata.failParentOnFailure),
        ...spreadIfDefined('dispatchMode', runMetadata.dispatchMode),
        ...spreadIfDefined('logsFileId', logsFileId),
        ...spreadIfDefined('updated', runMetadata.updated),
        ...spreadIfDefined('stepsCount', runMetadata.stepsCount),
    }
}

const POSTGRES_FOREIGN_KEY_VIOLATION = '23503'
const FLOW_RUN_LOGS_FILE_CONSTRAINT = 'fk_flow_run_logs_file_id'

function isLogsFileForeignKeyViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
        return false
    }
    const driverError: unknown = error.driverError
    return (
        typeof driverError === 'object' &&
        driverError !== null &&
        'code' in driverError &&
        driverError.code === POSTGRES_FOREIGN_KEY_VIOLATION &&
        'constraint' in driverError &&
        driverError.constraint === FLOW_RUN_LOGS_FILE_CONSTRAINT
    )
}

async function markParentRunAsFailed({
    parentRunId,
    parentWaitpointId,
    childRunId,
    projectId,
    log,
}: MarkParentRunAsFailedParams): Promise<void> {
    // A child predating `flow_run.parentWaitpointId` (#521 impact item 3 hardening) carries
    // `failParentOnFailure` with no stored proof to complete exactly. Falling back to whatever
    // waitpoint the parent happens to hold right now (the previous behavior) would reopen the
    // vulnerability this column exists to close — a replay, or an unrelated retry that changed the
    // parent's current waitpoint, could complete the wrong one. So a legacy child completes
    // nothing here; its parent stays PAUSED until manually retried or cancelled. The migration
    // (`AddParentWaitpointIdToFlowRun`) backfills this once for rows already in Postgres at
    // deploy time, matched against the parent's own single PENDING WEBHOOK waitpoint where
    // exactly one exists — this branch is the fallback for what the backfill could not resolve
    // (zero or multiple candidate waitpoints on the parent), plus any row that reaches this
    // state some other way: a job queued by the old API before the deploy but not landed in
    // Postgres until after the migration ran, or a split-version deploy where an old-code
    // instance still creates children without this column while new-code instances are already
    // reading it. Recovery for any of these is the same as before: retry or cancel the parent.
    if (isNil(parentWaitpointId)) {
        log.warn({ parentRunId, childRunId, projectId }, '[markParentRunAsFailed] Child run has failParentOnFailure but no stored parentWaitpointId (predates this check, or was never verified); completing nothing')
        return
    }

    const flowRun = await flowRunRepo().findOneBy({
        id: parentRunId,
        projectId,
    })

    if (isNil(flowRun)) {
        // parentRunId can come straight from the public webhook's `ap-parent-run-id` header
        // with no project check (webhook-request-converter.ts), so the child's own project is
        // the only trustworthy scope for this read.
        log.warn({ parentRunId, childRunId, projectId }, '[markParentRunAsFailed] Parent run not found in the child\'s project, skipping')
        return
    }

    if (isFlowRunStateTerminal({ status: flowRun.status, ignoreInternalError: false })) {
        return
    }

    const childRunUrl = await domainHelper.getPublicUrl({ path: `/projects/${projectId}/runs/${childRunId}` })
    const errorPayload = {
        body: {
            status: 'error',
            data: {
                message: 'Subflow execution failed',
                link: childRunUrl,
            },
        },
        headers: {},
        queryParams: {},
    }

    // Completes exactly `parentWaitpointId` and nothing else — `complete()` is a no-op unless
    // that id is still the PENDING row on `parentRunId`, so a replayed proof (this waitpoint
    // already COMPLETED) or a stale one (superseded by a later retry) is silently harmless rather
    // than completing whatever waitpoint the parent happens to hold at this later moment. No
    // `getByFlowRunId` fallback here on purpose: falling back to whatever waitpoint the parent
    // happens to hold right now would reopen the vulnerability `parentWaitpointId` exists to close.
    const result = await waitpointService(log).complete({
        flowRunId: parentRunId,
        projectId: flowRun.projectId,
        waitpointId: parentWaitpointId,
        resumePayload: errorPayload,
    })

    if (result.completedExisting && !isNil(result.waitpoint)) {
        await resumeService(log).resumeFromWaitpoint({
            flowRunId: parentRunId,
            waitpointId: result.waitpoint.id,
            resumePayload: result.waitpoint.resumePayload,
        })
    }
}

type MarkParentRunAsFailedParams = {
    parentRunId: string
    parentWaitpointId: string | undefined
    childRunId: string
    projectId: string
    log: FastifyBaseLogger
}

type DrainRunsMetadataParams = {
    log: FastifyBaseLogger
    job: Job<RunsMetadataJobData>
    key: string
}

type ConsumeProcessedMetadataParams = {
    key: string
    runMetadata: RunsMetadataUpsertData
}

type ResolveWritableLogsFileIdParams = {
    log: FastifyBaseLogger
    job: Job<RunsMetadataJobData>
    projectId: string
    runMetadata: RunsMetadataUpsertData
}

type UpdateFlowRunParams = {
    runId: string
    projectId: string
    runMetadata: RunsMetadataUpsertData
    logsFileId: string | undefined
    log: FastifyBaseLogger
    job: Job<RunsMetadataJobData>
}

type BuildFlowRunUpdateParams = {
    runMetadata: RunsMetadataUpsertData
    logsFileId: string | undefined
}
