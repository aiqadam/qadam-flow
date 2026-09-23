import { EngineResponseStatus, JobData, WorkerJobType, WorkerToApiContract } from '@aiqadam/shared'
import { Logger } from 'pino'
import { SandboxManager } from './sandbox-manager'

export enum JobResultKind {
    FIRE_AND_FORGET = 'FIRE_AND_FORGET',
    SYNCHRONOUS = 'SYNCHRONOUS',
}

export type JobContext = {
    apiClient: WorkerToApiContract
    sandboxManager: SandboxManager
    jobId: string
    // 0 only on this job's genuine first delivery to any worker; non-zero on a failed-and-retried
    // delivery OR a stalled-job re-delivery. Surfaced as `ConsumeJobRequest.attempsStarted` by the
    // broker, computed there as `job.attemptsMade + job.stalledCounter` — deliberately NOT BullMQ's
    // own `Job.attemptsStarted`, which also increments on a rate-limiter re-queue and would
    // misreport a still-fresh first delivery as "not first" (see job-broker.ts for the full
    // reasoning). Handlers use it to gate a check that must only ever run once per job, not once
    // per delivery (#510).
    attemptsStarted: number
    engineToken: string
    internalApiUrl: string
    publicApiUrl: string
    log: Logger
}

export type FireAndForgetJobResult = {
    kind: JobResultKind.FIRE_AND_FORGET
    status: EngineResponseStatus
    logs?: string
}

export type SynchronousJobResult = {
    kind: JobResultKind.SYNCHRONOUS
    status: EngineResponseStatus
    response: unknown
    errorMessage?: string
    logs?: string
}

export type JobResult = FireAndForgetJobResult | SynchronousJobResult

export type JobHandler<T extends JobData = JobData, R extends JobResult = JobResult> = {
    readonly jobType: WorkerJobType
    execute(ctx: JobContext, data: T): Promise<R>
}
