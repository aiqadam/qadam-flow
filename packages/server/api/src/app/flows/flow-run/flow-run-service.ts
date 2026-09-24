import { apDayjs } from '@aiqadam/server-utils'
import {
    apId,
    Cursor,
    EngineHttpResponse,
    ErrorCode,
    ExecuteFlowJobData,
    ExecutionType,
    ExecutioOutputFile,
    FileType,
    FlowId,
    FlowRetryStrategy,
    FlowRun,
    FlowRunCountByStatus,
    FlowRunDispatchMode,
    FlowRunId,
    FlowRunStatus,
    FlowRunWithRetryError,
    FlowVersion,
    FlowVersionId,
    isFlowRunStateTerminal,
    isNil,
    JobPayload,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    PlatformId,
    ProjectId,
    QadamFlowError,
    ResumeReason,
    RunEnvironment,
    RunInternalError,
    SampleDataFileType,
    SeekPage,
    StepOutput,
    StepOutputStatus,
    StreamStepProgress,
    tryCatch,
    WorkerJobType,
} from '@aiqadam/shared'
import { context, propagation, trace } from '@opentelemetry/api'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import pLimit from 'p-limit'
import { ArrayContains, In, IsNull, Not, Repository, SelectQueryBuilder } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { getPendingRunOwnerKey } from '../../database/redis/keys'
import { distributedStore } from '../../database/redis-connections'
import { fileService } from '../../file/file.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { projectService } from '../../project/project-service'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { payloadOffloader } from '../../workers/payload-offloader'
import { flowService } from '../flow/flow.service'
import { flowVersionService } from '../flow-version/flow-version.service'
import { sampleDataService } from '../step-run/sample-data.service'
import { FlowRunEntity } from './flow-run-entity'
import { flowRunSideEffects } from './flow-run-side-effects'
import { runsMetadataQueue } from './flow-runs-queue'
import { waitpointService } from './waitpoint/waitpoint-service'

const CANCELLABLE_STATUSES: FlowRunStatus[] = [FlowRunStatus.PAUSED, FlowRunStatus.QUEUED]

/**
 * Mirrors `REDACTED_VALUE` in `packages/server/engine/src/lib/helper/log-redaction.ts`. The api
 * package cannot import that module directly: `@aiqadam/engine`'s `package.json` declares no
 * `main`/`exports` entry, and the monorepo's own tsconfig path for the bare specifier resolves
 * to `packages/server/engine/src/main.ts` — the sandbox worker's own bootstrap, which pulls in
 * `isolated-vm` and other sandbox-only dependencies that must never load inside the api process.
 * Duplicated here as the single place `retry()` checks for it.
 */
const REDACTED_TRIGGER_OUTPUT_VALUE = '**REDACTED**'

const tracer = trace.getTracer('flow-run-service')
const PENDING_RUN_OWNER_TTL_SECONDS = system.getNumberOrThrow(AppSystemProp.FLOW_TIMEOUT_SECONDS)
export const WEBHOOK_TIMEOUT_MS = system.getNumberOrThrow(AppSystemProp.WEBHOOK_TIMEOUT_SECONDS) * 1000
/**
 * What a sync caller gets when AP_WEBHOOK_TIMEOUT_SECONDS runs out. Since the engine answers every
 * terminal verdict itself (flow.operation.ts), this is normally a run that is still queued,
 * executing or paused — or one whose answer never arrived (a failed publish) — so it must not read
 * as success the way the old empty 204 did (#509), and the body says only that it may be running.
 *
 * 504 rather than 408 or 503: the caller was not slow and we are not overloaded; the run behind us
 * did not answer in time. No `Retry-After`, deliberately — a retry starts the flow again from the
 * trigger, so inviting one duplicates every side effect a non-idempotent flow has already made.
 *
 * No `runId` either, for the same reason the failure 500 omits it: the legacy resume route
 * (`/:id/requests/:requestId`) accepts the run id alone as its credential, and a run can be paused
 * when this fires, so disclosing it would let the webhook caller resume — approve — its own run.
 */
export const SYNC_RUN_TIMEOUT_RESPONSE: EngineHttpResponse = {
    status: StatusCodes.GATEWAY_TIMEOUT,
    body: { message: 'The flow run did not respond within the time limit. It may still be running.' },
    headers: {},
}
export const flowRunRepo = repoFactory<FlowRun>(FlowRunEntity)
// V0 legacy resume needs pauseMetadata, which is deliberately excluded from the public FlowRun
// schema (see flow-run-entity.ts), and does not need findFlowRunOrThrow's flowVersion join (that
// join exists only to populate flowVersion.displayName for API responses; nothing on the legacy
// resume path reads it). repoFactory caches by entity name, so this is the same physical
// `flow_run` repository as flowRunRepo above, just retyped and queried without the join.
const flowRunLegacyResumeRepo = repoFactory<LegacyResumeFlowRun>(FlowRunEntity)

/**
 * A PRODUCTION run's row reaches Postgres through the runs-metadata queue rather than the request
 * that created it (`queueOrCreateInstantly`), so a parent accepted milliseconds ago is legitimately
 * absent from the table while that flush is still pending. Under load that failed ~46% of a burst's
 * runs on a parent that did exist (#509); TESTING writes the row synchronously, which is why a
 * manual test never reproduced it.
 *
 * The fallback reads `pending_run_owner:<id>`, which the API writes below when it accepts the run. It
 * must not read the `runs_metadata:` hash instead: `workerRpc.uploadRunLog` merges into that key with
 * an engine-supplied runId and projectId and no ownership check, so a compromised engine could mint
 * one for a foreign run — precisely the attachment this check exists to block.
 *
 * Shared by the inline-subflow depth guard (`inlineFlowRunService`) and by `resolveVerifiedParent`
 * below — both need "does this run belong to this project" answered the same way.
 */
export async function findParentRun({ parentRunId, projectId, log }: FindParentRunParams): Promise<ParentRun | null> {
    const persistedParentRun = await flowRunRepo().findOneBy({ id: parentRunId, projectId })
    if (!isNil(persistedParentRun)) {
        return { parentRunId: persistedParentRun.parentRunId, persisted: true }
    }

    const { data: pendingOwner, error } = await tryCatch(() => distributedStore.get<PendingRunOwner>(getPendingRunOwnerKey(parentRunId)))
    if (!isNil(error)) {
        // Fail closed: an unverifiable parent must never be accepted on the strength of a Redis blip.
        log.warn({ parentRunId, projectId, err: error }, '[flowRunService#findParentRun] Failed to read the pending run owner, treating parent as unverified')
        return null
    }
    if (isNil(pendingOwner) || pendingOwner.projectId !== projectId) {
        return null
    }
    return { parentRunId: pendingOwner.parentRunId, persisted: false }
}

export const flowRunService = (log: FastifyBaseLogger) => ({
    async upsert({ id, projectId }: { id: FlowRunId, projectId: ProjectId }): Promise<FlowRun> {
        const existingFlowRun = await flowRunRepo().findOneBy({ id, projectId })
        if (isNil(existingFlowRun)) {
            return flowRunRepo().save({ id, projectId })
        }
        return existingFlowRun
    },
    async list(params: ListParams): Promise<SeekPage<FlowRun>> {
        const decodedCursor = paginationHelper.decodeCursor(params.cursor)
        const paginator = buildPaginator<FlowRun>({
            entity: FlowRunEntity,
            query: {
                limit: params.limit,
                orderBy: [
                    { field: 'created', order: Order.DESC },
                    { field: 'id', order: Order.DESC },
                ],
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })


        const whereClause: Record<string, unknown> = {
            projectId: params.projectId,
        }
        if (!isNil(params.environment)) {
            whereClause.environment = params.environment
        }
        let query = queryBuilderForFlowRun(flowRunRepo()).where(whereClause)

        if (!params.includeArchived) {
            query = query.andWhere({
                archivedAt: IsNull(),
            })
        }

        if (params.flowId) {
            query = query.andWhere({
                flowId: In(params.flowId),
            })
        }
        if (params.status) {
            query = query.andWhere({
                status: In(params.status),
            })
        }
        if (params.createdAfter) {
            query = query.andWhere('flow_run.created >= :createdAfter', {
                createdAfter: params.createdAfter,
            })
        }
        if (params.createdBefore) {
            query = query.andWhere('flow_run.created <= :createdBefore', {
                createdBefore: params.createdBefore,
            })
        }
        if (params.tags) {
            query = query.andWhere({ tags: ArrayContains(params.tags) })
        }

        if (!isNil(params.failedStepName)) {
            query = query.andWhere('flow_run."failedStep"->>\'name\' = :failedStepName', {
                failedStepName: params.failedStepName,
            })
        }
        if (!isNil(params.failedStepMessage)) {
            query = query.andWhere('flow_run."failedStep"->>\'message\' ILIKE :failedStepMessage', {
                failedStepMessage: `%${params.failedStepMessage}%`,
            })
        }
        if (params.flowRunIds) {
            query = query.andWhere({
                id: In(params.flowRunIds),
            })
        }

        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<FlowRun>(data.map(withDispatchWaitMs), newCursor)
    },
    async retry({ flowRunId, strategy, projectId }: RetryParams): Promise<FlowRun> {
        const oldFlowRun = await flowRunService(log).getOnePopulatedOrThrow({
            id: flowRunId,
            projectId,
        })
        log.info({ runId: flowRunId, flowId: oldFlowRun.flowId, strategy }, 'Flow run retry initiated')

        const retentionDays = system.getNumberOrThrow(AppSystemProp.EXECUTION_DATA_RETENTION_DAYS)
        if (
            isFlowRunStateTerminal({ status: oldFlowRun.status, ignoreInternalError: false }) &&
            isOutsideRetentionWindow(oldFlowRun.created, retentionDays)
        ) {
            throw new QadamFlowError({
                code: ErrorCode.FLOW_RUN_RETRY_OUTSIDE_RETENTION,
                params: {
                    flowRunId: oldFlowRun.id,
                    failedJobRetentionDays: retentionDays,
                },
            })
        }

        switch (strategy) {
            case FlowRetryStrategy.FROM_FAILED_STEP: {
                const flowVersion = await flowVersionService(log).getOneOrThrow(oldFlowRun.flowVersionId)
                const triggerStep = oldFlowRun.steps?.[flowVersion.trigger.name]
                const triggerFailed = triggerStep?.status === StepOutputStatus.FAILED
                assertTriggerPayloadRetryable({ oldFlowRun, ranOnVersion: flowVersion, triggerStep })

                await flowRunRepo().update({
                    id: oldFlowRun.id,
                    projectId: oldFlowRun.projectId,
                }, {
                    status: FlowRunStatus.QUEUED,
                    startTime: apDayjs().toISOString(),
                    finishTime: null,
                })
                const updatedFlowRun = await findFlowRunOrThrow(oldFlowRun.id)
                const platformId = await projectService(log).getPlatformId(updatedFlowRun.projectId)
                await flowRunSideEffects(log).onRetry(updatedFlowRun)
                if (triggerFailed) {
                    return addToQueue({
                        flowRun: updatedFlowRun,
                        platformId,
                        payload: triggerStep.output,
                        streamStepProgress: StreamStepProgress.NONE,
                        executeTrigger: true,
                        executionType: ExecutionType.BEGIN,
                        workerHandlerId: undefined,
                        httpRequestId: undefined,
                    }, log)
                }
                return addToQueue({
                    flowRun: updatedFlowRun,
                    platformId,
                    streamStepProgress: StreamStepProgress.NONE,
                    executionType: ExecutionType.RESUME,
                    resumeReason: ResumeReason.RETRY,
                    workerHandlerId: undefined,
                    httpRequestId: undefined,
                }, log)
            }
            case FlowRetryStrategy.ON_LATEST_VERSION: {
                const latestFlowVersion = await flowVersionService(log).getLatestLockedVersionOrThrow(
                    oldFlowRun.flowId,
                )
                // The redaction check is against the version the run actually executed on, not
                // the latest one being retried to — that's the version whose `trigger.logOutput`
                // was in effect when this run's log was written.
                const ranOnVersion = await flowVersionService(log).getOneOrThrow(oldFlowRun.flowVersionId)
                const triggerStep = oldFlowRun.steps?.[latestFlowVersion.trigger.name]
                const triggerFailed = triggerStep?.status === StepOutputStatus.FAILED
                const payload = triggerStep?.output
                assertTriggerPayloadRetryable({ oldFlowRun, ranOnVersion, triggerStep: oldFlowRun.steps?.[ranOnVersion.trigger.name] })
                return this.start({
                    flowId: oldFlowRun.flowId,
                    payload,
                    platformId: await projectService(log).getPlatformId(oldFlowRun.projectId),
                    executionType: ExecutionType.BEGIN,
                    streamStepProgress: StreamStepProgress.NONE,
                    workerHandlerId: undefined,
                    httpRequestId: undefined,
                    executeTrigger: triggerFailed,
                    environment: oldFlowRun.environment,
                    flowVersionId: latestFlowVersion.id,
                    projectId: oldFlowRun.projectId,
                    failParentOnFailure: oldFlowRun.failParentOnFailure,
                    parentRunId: oldFlowRun.parentRunId,
                    // Safe to copy verbatim: `start` -> `queueOrCreateInstantly` re-verifies it
                    // via `resolveVerifiedParent` before it is ever persisted on the new run, so a
                    // waitpoint the original parent has since completed is dropped here rather
                    // than carried forward — and even if it weren't, `markParentRunAsFailed`
                    // completes exactly this id (`complete()` is a no-op on anything else), so a
                    // stale/consumed waitpoint could never complete the wrong one either way.
                    parentWaitpointId: oldFlowRun.parentWaitpointId,
                    // Re-verified the same way; a slot the first attempt already answered is no
                    // longer PENDING, so the retried run is created without it.
                    parentSlotId: oldFlowRun.parentSlotId,
                })
            }
        }
    },
    async cancel({ projectId, platformId, flowRunIds, excludeFlowRunIds, status, flowId, createdAfter, createdBefore }: CancelParams): Promise<void> {
        const filteredStatus = status ?? CANCELLABLE_STATUSES
        const flowRuns = await filterFlowRunsAndApplyFilters({
            projectId,
            flowRunIds,
            status: filteredStatus,
            flowId,
            createdAfter,
            createdBefore,
            excludeFlowRunIds,
        })
        const cancelParentFlowRuns = await Promise.allSettled(flowRuns.map(flowRun => cancelSingleRun(log, flowRun, platformId)))
        const childFlows = await getAllChildRuns({ parentRunIds: flowRuns.map(flowRun => flowRun.id), projectId })
        log.info({
            flowRunsCount: flowRuns.length,
            childFlowCount: childFlows.length,
        }, 'Found cancellable descendant flows')

        const canceChildlPromises = await Promise.allSettled(childFlows.map(flowRun => cancelSingleRun(log, flowRun, platformId)))
        if (cancelParentFlowRuns.some(r => r.status === 'rejected')) {
            throw cancelParentFlowRuns.find(r => r.status === 'rejected')!.reason
        }
        if (canceChildlPromises.some(r => r.status === 'rejected')) {
            throw canceChildlPromises.find(r => r.status === 'rejected')!.reason
        }
    },
    async existsBy(runId: FlowRunId): Promise<boolean> {
        return flowRunRepo().existsBy({ id: runId })
    },
    async bulkArchive(params: BulkArchiveActionParams): Promise<void> {
        const filteredFlowRuns = await filterFlowRunsAndApplyFilters(params)
        await flowRunRepo().update({
            id: In(filteredFlowRuns.map(flowRun => flowRun.id)),
            projectId: params.projectId,
        }, {
            archivedAt: new Date().toISOString(),
        })
    },
    async bulkRetry(params: BulkRetryParams): Promise<FlowRunWithRetryError[]> {
        const filteredFlowRuns = await filterFlowRunsAndApplyFilters(params)
        const limit = pLimit(10)
        const results = await Promise.allSettled(
            filteredFlowRuns.map(flowRun =>
                limit(() => this.retry({ flowRunId: flowRun.id, strategy: params.strategy, projectId: params.projectId })),
            ),
        )
        return results.map((result, i) => {
            if (result.status === 'fulfilled') {
                return result.value
            }
            const error = result.reason instanceof QadamFlowError ? result.reason : undefined
            return {
                ...filteredFlowRuns[i],
                error: {
                    errorCode: error?.error.code ?? ErrorCode.INTERNAL_SERVER_ERROR,
                    errorMessage: error?.message ?? 'Internal server error',
                },
            }
        })
    },
    async start({
        flowId,
        payload,
        executeTrigger,
        executionType,
        workerHandlerId,
        streamStepProgress,
        httpRequestId,
        projectId,
        flowVersionId,
        parentRunId,
        failParentOnFailure,
        parentWaitpointId,
        parentSlotId,
        platformId,
        stepNameToTest,
        environment,
        syncDeadline,
    }: StartParams): Promise<FlowRun> {
        return tracer.startActiveSpan('flowRun.start', {
            attributes: {
                'flowRun.flowVersionId': flowVersionId,
                'flowRun.projectId': projectId,
                'flowRun.environment': environment,
                'flowRun.executionType': executionType,
                'flowRun.streamStepProgress': streamStepProgress,
                'flowRun.executeTrigger': executeTrigger,
                'flowRun.httpRequestId': httpRequestId ?? 'none',
            },
        }, async (span) => {
            try {
                span.setAttribute('flowRun.flowId', flowId)

                const newFlowRun = await queueOrCreateInstantly({
                    projectId,
                    flowVersionId,
                    parentRunId,
                    flowId,
                    failParentOnFailure,
                    parentWaitpointId,
                    parentSlotId,
                    stepNameToTest,
                    environment,
                }, log)
                span.setAttribute('flowRun.id', newFlowRun.id)

                await addToQueue({
                    flowRun: newFlowRun,
                    platformId,
                    payload,
                    executeTrigger,
                    executionType,
                    workerHandlerId,
                    httpRequestId,
                    streamStepProgress,
                    syncDeadline,
                }, log)

                span.setAttribute('flowRun.queued', true)
                await flowRunSideEffects(log).onStart(newFlowRun)
                log.info({ runId: newFlowRun.id, flowId, projectId, executionType }, 'Flow run started')
                return newFlowRun
            }
            finally {
                span.end()
            }
        })
    },

    async test({ projectId, flowVersionId, parentRunId, stepNameToTest, triggeredBy }: TestParams): Promise<FlowRun> {
        const flowVersion = await flowVersionService(log).getOneOrThrow(flowVersionId)
        await flowService(log).getOneOrThrow({ id: flowVersion.flowId, projectId })

        const triggerPayload = await sampleDataService(log).getOrReturnEmpty({
            projectId,
            flowVersion,
            stepName: flowVersion.trigger.name,
            type: SampleDataFileType.OUTPUT,
        })
        const flowRun = await queueOrCreateInstantly({
            projectId,
            flowId: flowVersion.flowId,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.TESTING,
            parentRunId,
            failParentOnFailure: undefined,
            stepNameToTest,
            triggeredBy,
        }, log)
        return addToQueue({
            flowRun,
            payload: triggerPayload,
            executionType: ExecutionType.BEGIN,
            workerHandlerId: undefined,
            httpRequestId: undefined,
            platformId: await projectService(log).getPlatformId(projectId),
            executeTrigger: false,
            streamStepProgress: StreamStepProgress.WEBSOCKET,
            sampleData: !isNil(stepNameToTest) ? await sampleDataService(log).getSampleDataForFlow(projectId, flowVersion, SampleDataFileType.OUTPUT) : undefined,
        }, log)
    },
    async startManualTrigger({ projectId, flowVersionId, triggeredBy }: StartManualTriggerParams): Promise<FlowRun> {
        const flowVersion = await flowVersionService(log).getOneOrThrow(flowVersionId)
        await flowService(log).getOneOrThrow({ id: flowVersion.flowId, projectId })
        const triggerPayload = {}
        const flowRun = await queueOrCreateInstantly({
            projectId,
            flowId: flowVersion.flowId,
            flowVersionId: flowVersion.id,
            environment: RunEnvironment.PRODUCTION,
            parentRunId: undefined,
            failParentOnFailure: undefined,
            stepNameToTest: undefined,
            triggeredBy,
        }, log)
        return addToQueue({
            flowRun,
            payload: triggerPayload,
            executionType: ExecutionType.BEGIN,
            workerHandlerId: undefined,
            httpRequestId: undefined,
            platformId: await projectService(log).getPlatformId(projectId),
            executeTrigger: false,
            streamStepProgress: StreamStepProgress.WEBSOCKET,
            sampleData: undefined,
        }, log)
    },
    async getOne(params: GetOneParams): Promise<FlowRun | null> {
        const flowRun = await queryBuilderForFlowRun(flowRunRepo()).where({
            id: params.id,
            ...(params.projectId ? { projectId: params.projectId } : {}),
        }).getOne()

        return isNil(flowRun) ? flowRun : withDispatchWaitMs(flowRun)
    },
    async getOneOrThrow(params: GetOneParams): Promise<FlowRun> {
        const flowRun = await this.getOne(params)

        if (isNil(flowRun)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'flow_run',
                    entityId: params.id,
                    message: 'Flow run not found',
                },
            })
        }

        return flowRun
    },
    async countByStatus(params: CountByStatusParams): Promise<FlowRunCountByStatus[]> {
        let query = flowRunRepo().createQueryBuilder('flow_run')
            .select('flow_run.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .where({
                projectId: params.projectId,
                environment: RunEnvironment.PRODUCTION,
                archivedAt: IsNull(),
            })
            .groupBy('flow_run.status')

        if (params.createdAfter) {
            query = query.andWhere('flow_run.created >= :createdAfter', { createdAfter: params.createdAfter })
        }
        if (params.createdBefore) {
            query = query.andWhere('flow_run.created <= :createdBefore', { createdBefore: params.createdBefore })
        }

        const results = await query.getRawMany()
        return results.map((r: { status: FlowRunStatus, count: string }) => ({ status: r.status, count: parseInt(r.count, 10) }))
    },
    async getOnePopulatedOrThrow(params: GetOneParams): Promise<FlowRun> {
        const flowRun = await this.getOneOrThrow(params)
        let steps = {}
        let internalError: RunInternalError | undefined = undefined
        if (!isNil(flowRun.logsFileId)) {
            const stateFile = await readLogsFile(log, flowRun.logsFileId, flowRun.projectId)
            if (!isNil(stateFile)) {
                steps = stateFile.executionState.steps
                internalError = stateFile.internalError
            }
        }
        return {
            ...flowRun,
            steps,
            internalError,
        }
    },
})


/**
 * Refuses a retry whose old run cannot supply a real trigger payload to replay, for either
 * strategy — see the three mechanisms documented in flow-runs.md's Logs Storage and Retry
 * Strategies sections: a redacted trigger's terminal log backup, a redacted failed-trigger's
 * preserved raw event, and RESUME hydrating a redacted trigger step from the log. `ranOnVersion`
 * must be the flow version the OLD run actually executed on (its `trigger.logOutput` reflects
 * the setting in effect when the log was written, not whatever the trigger is configured to do
 * now) — never the latest/target version, which may have logging on even though this run's own
 * log holds `**REDACTED**`.
 */
function assertTriggerPayloadRetryable({ oldFlowRun, ranOnVersion, triggerStep }: AssertTriggerPayloadRetryableParams): void {
    const triggerOutputRedacted = triggerStep?.output === REDACTED_TRIGGER_OUTPUT_VALUE
    if (ranOnVersion.trigger.logOutput !== false && !triggerOutputRedacted) {
        return
    }
    const message = `Can't retry run ${oldFlowRun.id}: its trigger payload was not kept in the run log because logging was turned off for the trigger. Re-trigger the flow with a fresh event, or turn trigger logging back on for future runs before retrying.`
    throw new QadamFlowError({ code: ErrorCode.VALIDATION, params: { message } }, message)
}

async function cancelSingleRun(log: FastifyBaseLogger, flowRun: FlowRun, platformId: string): Promise<void> {
    await jobQueue(log).removeOneTimeJob({
        jobId: flowRun.id,
        platformId,
    })
    await runsMetadataQueue(log).add({
        id: flowRun.id,
        projectId: flowRun.projectId,
        status: FlowRunStatus.CANCELED,
    })
    log.info({
        runId: flowRun.id,
        flowId: flowRun.flowId,
    }, 'Flow run cancelled')
}

/**
 * Scoped by projectId at the anchor AND on every recursive hop — without it, a descendant chain that
 * crosses into another project (e.g. a webhook-forged `parentRunId`, see #521) would let one
 * project's bulk cancel reach into another project's runs. `parentRunIds` are already all from
 * `projectId` (filterFlowRunsAndApplyFilters), so this only ever walks that project's own tree.
 */
async function getAllChildRuns({ parentRunIds, projectId }: GetAllChildRunsParams): Promise<FlowRun[]> {
    if (parentRunIds.length === 0) {
        return []
    }

    const query = `
        WITH RECURSIVE descendants AS (
            SELECT *
            FROM flow_run
            WHERE "parentRunId" = ANY($1)
              AND "projectId" = $2
              AND status = ANY($3)

            UNION ALL

            SELECT f.*
            FROM flow_run f
            INNER JOIN descendants d ON f."parentRunId" = d.id
            WHERE f."projectId" = $2
              AND f.status = ANY($3)
        )
        SELECT * FROM descendants;
    `

    const params = [
        parentRunIds,
        projectId,
        CANCELLABLE_STATUSES,
    ]

    const results = await flowRunRepo().query(query, params)
    return results as FlowRun[]
}


async function filterFlowRunsAndApplyFilters(
    params: FilterFlowRunsAndApplyFiltersParams,
): Promise<FlowRun[]> {
    let query = flowRunRepo().createQueryBuilder('flow_run').where({
        projectId: params.projectId,
        environment: RunEnvironment.PRODUCTION,
    })

    if (!isNil(params.flowRunIds) && params.flowRunIds.length > 0) {
        query = query.andWhere({
            id: In(params.flowRunIds),
        })
    }

    if (!isNil(params.archived)) {
        query = query.andWhere({
            archivedAt: params.archived ? Not(IsNull()) : IsNull(),
        })
    }

    if (params.flowId && params.flowId.length > 0) {
        query = query.andWhere({
            flowId: In(params.flowId),
        })
    }
    if (params.status && params.status.length > 0) {
        query = query.andWhere({
            status: In(params.status),
        })
    }
    if (params.createdAfter) {
        query = query.andWhere('flow_run.created >= :createdAfter', {
            createdAfter: params.createdAfter,
        })
    }
    if (params.createdBefore) {
        query = query.andWhere('flow_run.created <= :createdBefore', {
            createdBefore: params.createdBefore,
        })
    }
    if (params.excludeFlowRunIds && params.excludeFlowRunIds.length > 0) {
        query = query.andWhere({
            id: Not(In(params.excludeFlowRunIds)),
        })
    }

    if (params.failedStepName) {
        query = query.andWhere('flow_run.failedStepName = :failedStepName', {
            failedStepName: params.failedStepName,
        })
    }
    if (params.failedStepMessage) {
        query = query.andWhere('flow_run."failedStep"->>\'message\' ILIKE :failedStepMessage', {
            failedStepMessage: `%${params.failedStepMessage}%`,
        })
    }

    const flowRuns = await query.getMany()
    return flowRuns
}


export async function addToQueue(params: AddToQueueParams, log: FastifyBaseLogger): Promise<FlowRun> {
    const logsFileId = params.flowRun.logsFileId ?? apId()

    const traceContext: Record<string, string> = {}
    propagation.inject(context.active(), traceContext)

    let jobPayload: JobPayload = { type: 'inline', value: null }
    if (!isNil(params.payload) && isNil(params.workerHandlerId)) {
        jobPayload = await payloadOffloader.offloadPayload(log, params.payload, params.flowRun.projectId, params.platformId)
    }
    else if (!isNil(params.payload)) {
        jobPayload = await payloadOffloader.maybeOffloadPayload(log, params.payload, params.flowRun.projectId, params.platformId)
    }

    const commonJobData = {
        schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
        workerHandlerId: params.workerHandlerId ?? null,
        projectId: params.flowRun.projectId,
        platformId: params.platformId,
        environment: params.flowRun.environment,
        flowId: params.flowRun.flowId,
        runId: params.flowRun.id,
        jobType: WorkerJobType.EXECUTE_FLOW as const,
        flowVersionId: params.flowRun.flowVersionId,
        payload: jobPayload,
        httpRequestId: params.httpRequestId,
        streamStepProgress: params.streamStepProgress,
        stepNameToTest: params.flowRun.stepNameToTest ?? undefined,
        sampleData: params.sampleData,
        logsFileId,
        traceContext,
        syncDeadline: params.syncDeadline,
    }
    const data: ExecuteFlowJobData = params.executionType === ExecutionType.RESUME
        ? {
            ...commonJobData,
            executionType: ExecutionType.RESUME,
            resumeReason: params.resumeReason,
        }
        : {
            ...commonJobData,
            executionType: ExecutionType.BEGIN,
            executeTrigger: params.executeTrigger,
        }
    await jobQueue(log).add({
        id: params.flowRun.id,
        type: JobType.ONE_TIME,
        data,
    })
    return params.flowRun
}

export async function findFlowRunOrThrow(flowRunId: FlowRunId): Promise<FlowRun> {
    const flowRun = await queryBuilderForFlowRun(flowRunRepo()).where({ id: flowRunId }).getOne()
    if (isNil(flowRun)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'flow_run',
                entityId: flowRunId,
                message: 'Flow run not found',
            },
        })
    }
    return flowRun
}

/**
 * Resolves the run for the V0 legacy resume routes (`/:id/requests/:requestId[/sync]`). If the
 * run has no PENDING V0 waitpoint, this is the ONLY read: resume-service's no-waitpoint legacy
 * branch (legacyResume/legacySyncResume) takes the resolved row as a parameter and never
 * re-fetches it. That closes a check-then-use gap that used to exist there — findPendingV0Waitpoint
 * resolving the run, then legacyResume/legacySyncResume resolving it again — where the #509
 * runsMetadataQueue drain lag could insert a PAUSED row, or the real waitpoint row, in between the
 * two reads, so a request that saw "no V0 waitpoint yet" on the first read could still land in the
 * no-waitpoint branch on the second. A single un-joined read (dropping findFlowRunOrThrow's
 * flowVersion join, unused here) returns everything that branch needs — the eligibility guard's
 * inputs (status, pauseMetadata) and everything enqueueResume needs to dispatch the resume
 * (flowId, flowVersionId, environment, logsFileId, stepNameToTest).
 *
 * If the run DOES have a PENDING V0 waitpoint, the controller still re-resolves it a second time
 * inside resumeFromWaitpoint (via findFlowRunOrThrow) before completing that waitpoint. That
 * second read is safe from the same race: handleResumeSignal locks that exact waitpoint id
 * (pessimistic write) and deletes it in the same transaction before its onReady callback enqueues
 * the resume, so a second, unrelated waitpoint appearing between the two reads cannot be silently
 * swapped in — there is nothing analogous to fix on that branch.
 */
export async function findFlowRunForLegacyResume({ flowRunId }: FindFlowRunForLegacyResumeParams): Promise<LegacyResumeFlowRun> {
    const flowRun = await flowRunLegacyResumeRepo().findOneBy({ id: flowRunId })
    if (isNil(flowRun)) {
        throw new QadamFlowError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'flow_run',
                entityId: flowRunId,
                message: 'Flow run not found',
            },
        })
    }
    return flowRun
}

function queryBuilderForFlowRun(repo: Repository<FlowRun>): SelectQueryBuilder<FlowRun> {
    return repo.createQueryBuilder('flow_run')
        .leftJoinAndSelect('flow_run.flowVersion', 'flowVersion')
        .addSelect(['"flowVersion"."displayName"'])
}

async function readLogsFile(log: FastifyBaseLogger, logsFileId: string, projectId: string): Promise<ExecutioOutputFile | null> {
    const result = await fileService(log).getDataOrUndefined({
        projectId,
        fileId: logsFileId,
        type: FileType.FLOW_RUN_LOG,
    })
    if (isNil(result)) {
        return null
    }
    return JSON.parse(result.data.toString('utf-8'))
}

/**
 * A `parentRunId` reaching this point can be caller-controlled — the `ap-parent-run-id` webhook
 * header rides job data all the way from a public, unauthenticated route through to here for both
 * the sync and async webhook paths (`webhook.service.ts#handleSync`, `execute-webhook.ts` →
 * `submitPayloads`) — and must never be attached on the strength of the caller's word alone: it can
 * name a run in any project, which would let that project's own cancel/waitpoint machinery reach a
 * foreign run (#521). This is the single choke point every `start()` caller funnels through, so
 * verifying here (rather than at webhook ingress) covers every route without duplicating the check.
 * A parent that fails verification is dropped, together with `failParentOnFailure` — the run must
 * still start, just unparented; the caller gets no signal either way.
 *
 * `parentWaitpointId` is re-verified here too, not just at webhook ingress: `submitPayloads` is a
 * WORKER-authenticated RPC method, callable directly by any worker, not only as the tail end of
 * the webhook job `execute-webhook.ts` builds — so a `parentWaitpointId` reaching here has not
 * necessarily passed through `webhook.service.ts#resolveParentAttachment`'s
 * `existsPendingWebhookWaitpoint` check at all. Without re-checking it here, an unverified id
 * would still be persisted and later handed to `waitpointService.complete()` as-is, which matches
 * on id + PENDING status only, not on waitpoint type — so an id naming some *other* PENDING
 * waitpoint on the same (now-verified) parent, e.g. a DELAY or an unrelated approval step, could
 * be completed by an ordinary child failure instead of only ever the parent's own WEBHOOK
 * waitpoint. Re-running the same check the legitimate call-flow proof already passed at ingress is
 * therefore harmless for the real path (the parent is still waiting on its own WEBHOOK waitpoint
 * at run-creation time — nothing can have completed it yet, since completion only ever happens
 * later, when this very child terminates) and closes the gap for a WORKER principal calling
 * `submitPayloads` directly.
 */
async function resolveVerifiedParent({ parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId, projectId, log }: ResolveVerifiedParentParams): Promise<ResolvedParent> {
    if (isNil(parentRunId)) {
        return { parentRunId: undefined, failParentOnFailure, parentWaitpointId: undefined, parentSlotId: undefined }
    }
    const verifiedParent = await findParentRun({ parentRunId, projectId, log })
    if (isNil(verifiedParent)) {
        log.warn({ parentRunId, projectId }, '[flowRunService#resolveVerifiedParent] Dropping parentRunId: the named run does not belong to this project')
        // `false`, not `undefined`: queueOrCreateInstantly defaults a genuinely-absent
        // failParentOnFailure to `true` (`failParentOnFailure ?? true`), so `undefined` here would
        // read as "no preference" and re-enable exactly the flag this branch exists to drop.
        return { parentRunId: undefined, failParentOnFailure: false, parentWaitpointId: undefined, parentSlotId: undefined }
    }
    // A waitpoint id is only ever meaningful alongside a `true` failParentOnFailure — dropping it
    // otherwise keeps `flow_run.parentWaitpointId` from persisting a value nothing will ever read.
    if (!failParentOnFailure || isNil(parentWaitpointId)) {
        return { parentRunId, failParentOnFailure, parentWaitpointId: undefined, parentSlotId: undefined }
    }
    const proof = await waitpointService(log).findVerifiedParentJoinSlot({
        parentRunId,
        parentWaitpointId,
        parentSlotId,
        projectId,
    })
    // A join waitpoint (#374) is proven only together with one of its own PENDING slots: its id alone
    // is in every child's callback URL, and must not let a child answer, or fail, the whole join.
    if (!proof.waitpointProven || (proof.isJoin && !proof.slotProven)) {
        log.warn({ parentRunId }, '[flowRunService#resolveVerifiedParent] Dropping failParentOnFailure: parentWaitpointId (and parentSlotId, for a join) did not re-verify against a PENDING WEBHOOK waitpoint on this parent')
        return { parentRunId, failParentOnFailure: false, parentWaitpointId: undefined, parentSlotId: undefined }
    }
    return { parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId: proof.isJoin ? parentSlotId : undefined }
}

// A join slot (#374) belongs to the first child created for it: a parent step that is replayed
// re-dispatches only the slots with no child yet, and a second child for the same slot is not
// attached to the join — its failure answers nothing. (It still carries the slot's callback URL, so
// its own Return Response can answer; the first answer wins, and both process the same item.)
async function claimJoinSlot({ verified, childRunId, projectId, log }: ClaimJoinSlotParams): Promise<ResolvedParent> {
    if (isNil(verified.parentSlotId) || isNil(verified.parentWaitpointId)) {
        return verified
    }
    const claimed = await waitpointService(log).claimSlot({ slotId: verified.parentSlotId, waitpointId: verified.parentWaitpointId, projectId, childRunId })
    if (claimed) {
        return verified
    }
    log.warn({ parentRunId: verified.parentRunId }, '[flowRunService#claimJoinSlot] Join slot already has a child; starting this run detached from the join')
    return { parentRunId: verified.parentRunId, failParentOnFailure: false, parentWaitpointId: undefined, parentSlotId: undefined }
}

async function queueOrCreateInstantly(params: CreateParams, log: FastifyBaseLogger): Promise<FlowRun> {
    const now = new Date().toISOString()
    const verified = await resolveVerifiedParent({
        parentRunId: params.parentRunId,
        failParentOnFailure: params.failParentOnFailure,
        parentWaitpointId: params.parentWaitpointId,
        parentSlotId: params.parentSlotId,
        projectId: params.projectId,
        log,
    })
    const id = apId()
    const { parentRunId, failParentOnFailure, parentWaitpointId, parentSlotId } = await claimJoinSlot({ verified, childRunId: id, projectId: params.projectId, log })
    const flowRun: FlowRun = {
        id,
        projectId: params.projectId,
        flowId: params.flowId,
        flowVersionId: params.flowVersionId,
        environment: params.environment,
        parentRunId,
        parentWaitpointId,
        parentSlotId,
        // Only a subflow child (parentRunId set) has a meaningful dispatch mode —
        // a top-level run isn't dispatched by a parent at all. This is the queue
        // path specifically; the inline path writes its own run row directly in
        // inlineFlowRunService.start, never through here.
        dispatchMode: isNil(parentRunId) ? undefined : FlowRunDispatchMode.enum.QUEUE,
        failParentOnFailure: failParentOnFailure ?? true,
        status: FlowRunStatus.QUEUED,
        stepNameToTest: params.stepNameToTest,
        created: now,
        updated: now,
        tags: [],
        steps: {},
        triggeredBy: params.triggeredBy,
    }
    const { data: created, error } = await tryCatch(() => persistOrQueueRun({ flowRun, environment: params.environment, log }))
    if (error) {
        // A claim for a run that never came to exist would leave its slot unanswerable and never
        // re-dispatched; the retried request claims it again.
        if (!isNil(parentSlotId)) {
            await waitpointService(log).releaseSlotClaim({ slotId: parentSlotId, projectId: params.projectId, childRunId: id })
        }
        throw error
    }
    return created
}

async function persistOrQueueRun({ flowRun, environment, log }: PersistOrQueueRunParams): Promise<FlowRun> {
    switch (environment) {
        case RunEnvironment.TESTING:
            return flowRunRepo().save(flowRun)
        case RunEnvironment.PRODUCTION:
            // The row itself is owed by the runs-metadata queue, so for the length of that flush
            // the run exists everywhere except the table. An inline subflow dispatched in the
            // meantime still has to prove its parent belongs to its own project, and this is the
            // only record of that written by the API rather than by anything the engine can reach
            // (#509). Scoped to the run's own outside limit — past FLOW_TIMEOUT_SECONDS the run
            // cannot still be executing, so the record has nothing left to authorize.
            await distributedStore.put(getPendingRunOwnerKey(flowRun.id), {
                projectId: flowRun.projectId,
                parentRunId: flowRun.parentRunId,
            }, PENDING_RUN_OWNER_TTL_SECONDS)
            await runsMetadataQueue(log).add(flowRun)
            return flowRun
    }
}

/**
 * `dispatchWaitMs` is the time between this run becoming eligible for dispatch and the engine
 * actually beginning execution — `startTime - created`, computed here rather than stored, so no
 * migration is needed and the definition can't drift from what's actually on the row.
 *
 * Two cases where the raw `startTime - created` gap does not mean "queue wait", both documented
 * rather than special-cased away (#510):
 *
 * - INLINE dispatch mode (`inline-flow-run.service.ts`) sets `startTime` equal to `created` at row
 *   creation, since an inline child starts executing synchronously in its parent's own engine
 *   process. The gap is correctly 0 by construction; nothing here needs to special-case it.
 * - A FROM_FAILED_STEP retry reuses the same run row and resets `startTime` to the moment the retry
 *   was queued, while `created` still holds the run's ORIGINAL creation time. `dispatchWaitMs` on a
 *   retried run therefore measures elapsed time since the original attempt, not the latest retry's
 *   own queue wait — informative for the run's lifetime, but not a live per-dispatch health metric
 *   across retries. Resetting `created` on retry was considered and rejected: `created` is this
 *   row's audit trail of when it first came into existence, and list/filter queries
 *   (`createdAfter`/`createdBefore` above) rely on it staying put.
 */
function withDispatchWaitMs(flowRun: FlowRun): FlowRun {
    if (isNil(flowRun.startTime)) {
        return { ...flowRun, dispatchWaitMs: null }
    }
    const waitMs = apDayjs(flowRun.startTime).diff(apDayjs(flowRun.created))
    return { ...flowRun, dispatchWaitMs: waitMs >= 0 ? waitMs : null }
}

export function isOutsideRetentionWindow(createdTime: string, retentionDays: number): boolean {
    if (!createdTime) return false
    return apDayjs(createdTime).add(retentionDays, 'day').isBefore(apDayjs())
}

type CreateParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
    triggeredBy?: string
    parentRunId?: FlowRunId
    failParentOnFailure: boolean | undefined
    parentWaitpointId?: string
    parentSlotId?: string
    stepNameToTest?: string
    flowId: FlowId
    environment: RunEnvironment
}

type GetAllChildRunsParams = {
    parentRunIds: string[]
    projectId: ProjectId
}

type ResolveVerifiedParentParams = {
    parentRunId: FlowRunId | undefined
    failParentOnFailure: boolean | undefined
    parentWaitpointId: string | undefined
    parentSlotId: string | undefined
    projectId: ProjectId
    log: FastifyBaseLogger
}

type PersistOrQueueRunParams = {
    flowRun: FlowRun
    environment: RunEnvironment
    log: FastifyBaseLogger
}

type ClaimJoinSlotParams = {
    verified: ResolvedParent
    childRunId: string
    projectId: ProjectId
    log: FastifyBaseLogger
}

type ResolvedParent = {
    parentRunId: FlowRunId | undefined
    failParentOnFailure: boolean | undefined
    parentWaitpointId: string | undefined
    parentSlotId: string | undefined
}

export type FindParentRunParams = {
    parentRunId: string
    projectId: string
    log: FastifyBaseLogger
}

export type ParentRun = {
    parentRunId?: string
    persisted: boolean
}

type PendingRunOwner = {
    projectId: string
    parentRunId?: string
}

type ListParams = {
    projectId: ProjectId
    flowId: FlowId[] | undefined
    status: FlowRunStatus[] | undefined
    cursor: Cursor | null
    tags?: string[]
    limit: number
    createdAfter?: string
    createdBefore?: string
    failedStepName?: string
    failedStepMessage?: string
    flowRunIds?: FlowRunId[]
    includeArchived?: boolean
    environment?: RunEnvironment
}

type GetOneParams = {
    id: FlowRunId
    projectId: ProjectId | undefined
}

type AddToQueueParamsCommon = {
    flowRun: FlowRun
    platformId: PlatformId
    payload?: unknown
    workerHandlerId: string | undefined
    httpRequestId: string | undefined
    streamStepProgress: StreamStepProgress
    sampleData?: Record<string, unknown>
    syncDeadline?: string
}

export type AddToQueueParams = AddToQueueParamsCommon & (
    | { executionType: ExecutionType.BEGIN, executeTrigger: boolean }
    | { executionType: ExecutionType.RESUME, resumeReason: ResumeReason }
)


type StartParams = {
    flowId: FlowId
    payload: unknown
    platformId: PlatformId
    environment: RunEnvironment
    flowVersionId: FlowVersionId
    projectId: ProjectId
    parentRunId?: FlowRunId
    failParentOnFailure: boolean | undefined
    parentWaitpointId?: string
    parentSlotId?: string
    stepNameToTest?: string
    executeTrigger: boolean
    executionType: ExecutionType.BEGIN
    workerHandlerId: string | undefined
    httpRequestId: string | undefined
    streamStepProgress: StreamStepProgress
    sampleData?: Record<string, unknown>
    syncDeadline?: string
}



type TestParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
    triggeredBy?: string
    parentRunId?: FlowRunId
    stepNameToTest?: string
}

type StartManualTriggerParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
    triggeredBy: string
}
type RetryParams = {
    flowRunId: FlowRunId
    strategy: FlowRetryStrategy
    projectId: ProjectId
}

type AssertTriggerPayloadRetryableParams = {
    oldFlowRun: FlowRun
    ranOnVersion: FlowVersion
    triggerStep: StepOutput | undefined
}

type CancelParams = {
    projectId: ProjectId
    platformId: PlatformId
    flowRunIds?: FlowRunId[]
    excludeFlowRunIds?: FlowRunId[]
    status?: FlowRunStatus[]
    flowId?: FlowId[]
    createdAfter?: string
    createdBefore?: string
}

type BulkRetryParams = {
    projectId: ProjectId
    flowRunIds?: FlowRunId[]
    strategy: FlowRetryStrategy
    status?: FlowRunStatus[]
    flowId?: FlowId[]
    createdAfter?: string
    archived?: boolean
    createdBefore?: string
    excludeFlowRunIds?: FlowRunId[]
    failedStepName?: string
    failedStepMessage?: string
}

type BulkArchiveActionParams = {
    projectId: ProjectId
    flowRunIds?: FlowRunId[]
    status?: FlowRunStatus[]
    flowId?: FlowId[]
    createdAfter?: string
    archived?: boolean
    createdBefore?: string
    excludeFlowRunIds?: FlowRunId[]
    failedStepName?: string
    failedStepMessage?: string
}

type CountByStatusParams = {
    projectId: ProjectId
    createdAfter?: string
    createdBefore?: string
}

export type FindFlowRunForLegacyResumeParams = {
    flowRunId: FlowRunId
}

// pauseMetadata is a pre-shim (before 2026-04-13) column, deliberately excluded from the public
// FlowRun schema — see flow-run-entity.ts. Everything else here is exactly what FlowRun already
// carries; this is the same row, just also exposing that one legacy column.
export type LegacyResumeFlowRun = FlowRun & {
    pauseMetadata?: unknown
}

type FilterFlowRunsAndApplyFiltersParams = {
    projectId: ProjectId
    flowRunIds?: FlowRunId[]
    status?: FlowRunStatus[]
    archived?: boolean
    flowId?: FlowId[]
    createdAfter?: string
    createdBefore?: string
    excludeFlowRunIds?: FlowRunId[]
    failedStepName?: string
    failedStepMessage?: string
}
