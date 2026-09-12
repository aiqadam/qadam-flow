import { Flow, FlowId, FlowRunId, Metadata, PlatformId, ProjectId, UserId } from '@aiqadam/shared'
import { Job, JobsOptions } from 'bullmq'
import { Dayjs } from 'dayjs'

export enum SystemJobName {
    PIECES_ANALYTICS = 'qadams-analytics',
    FILE_CLEANUP_TRIGGER = 'file-cleanup-trigger',
    STORE_ENTRY_CLEANUP = 'store-entry-cleanup',
    TRIAL_TRACKER = 'trial-tracker',
    RUN_TELEMETRY = 'run-telemetry',
    DELETE_FLOW = 'delete-flow',
    HARD_DELETE_PROJECT = 'hard-delete-project',
    HARD_DELETE_PLATFORM = 'hard-delete-platform',
    RESUME_DELAY_WAITPOINT = 'resume-delay-waitpoint',
    APPLY_DELIVERY_MODE_CHANGE = 'apply-delivery-mode-change',
}

type DeleteFlowDurableSystemJobData =  {
    flow: Flow
    preDeleteDone: boolean
}

type HardDeleteProjectSystemJobData = {
    projectId: ProjectId
    platformId: PlatformId
    preDeletedFlowIds: FlowId[]
}

type HardDeletePlatformSystemJobData = {
    platformId: PlatformId
    userId: UserId
    identityId: string
}

type ResumeDelayWaitpointSystemJobData = {
    flowRunId: FlowRunId
    projectId: ProjectId
    waitpointId: string
}

/**
 * A connection's delivery mode changed, and the trigger hooks that act on it have to be re-run.
 *
 * Durable rather than a floating promise because losing it is silent and one-directional: webhook
 * -> long polling self-heals, since the registry re-reads the connection every minute, but long
 * polling -> webhook does not. There the metadata already says webhook, so the registry drops those
 * flows while the qadam's `onEnable` — the only thing that re-registers the webhook it deleted —
 * never runs, and the flow sits enabled and receiving nothing until someone republishes it.
 */
type ApplyDeliveryModeChangeSystemJobData = {
    qadamName: string
    projectIds: ProjectId[]
    externalId: string
    before: Metadata | null
    after: Metadata | null
    /** Re-run regardless of whether the puller's verdict changed; see the `upsert` call site. */
    always: boolean
}

type SystemJobDataMap = {
    [SystemJobName.PIECES_ANALYTICS]: Record<string, never>
    [SystemJobName.FILE_CLEANUP_TRIGGER]: Record<string, never>
    [SystemJobName.STORE_ENTRY_CLEANUP]: Record<string, never>
    [SystemJobName.RUN_TELEMETRY]: Record<string, never>
    [SystemJobName.TRIAL_TRACKER]: Record<string, never>
    [SystemJobName.DELETE_FLOW]: DeleteFlowDurableSystemJobData
    [SystemJobName.HARD_DELETE_PROJECT]: HardDeleteProjectSystemJobData
    [SystemJobName.HARD_DELETE_PLATFORM]: HardDeletePlatformSystemJobData
    [SystemJobName.RESUME_DELAY_WAITPOINT]: ResumeDelayWaitpointSystemJobData
    [SystemJobName.APPLY_DELIVERY_MODE_CHANGE]: ApplyDeliveryModeChangeSystemJobData
}

export type SystemJobData<T extends SystemJobName = SystemJobName> = T extends SystemJobName ? SystemJobDataMap[T] : never

export type SystemJobDefinition<T extends SystemJobName> = {
    name: T
    data: SystemJobData<T>
    jobId: string
}

export type SystemJobHandler<T extends SystemJobName = SystemJobName> = (data: SystemJobData<T>) => Promise<void>

type OneTimeJobSchedule = {
    type: 'one-time'
    date: Dayjs
}

type RepeatedJobSchedule = {
    type: 'repeated'
    cron: string
}

export type JobSchedule = OneTimeJobSchedule | RepeatedJobSchedule

type UpsertJobParams<T extends SystemJobName> = {
    job: SystemJobDefinition<T>
    schedule: JobSchedule
    customConfig?: JobsOptions
}

export type SystemJobSchedule = {
    init(): Promise<void>
    startWorker(): Promise<void>
    upsertJob<T extends SystemJobName>(params: UpsertJobParams<T>): Promise<void>
    getJob<T extends SystemJobName>(jobId: string): Promise<Job<SystemJobData<T>> | undefined>
    close(): Promise<void>
}
