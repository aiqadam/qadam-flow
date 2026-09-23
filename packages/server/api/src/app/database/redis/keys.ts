import { ApId, ProjectId } from '@aiqadam/shared'

export const getConcurrencyPoolSetKey = (poolId: string): string => `active_jobs_set:pool:${poolId}`
export const getProjectMaxConcurrentJobsKey = (projectId: ProjectId): string => `project:max_concurrent_jobs:${projectId}`

/**
 * Ownership of a run whose row is still queued for Postgres. Written only by the API when it
 * accepts the run, and read when an inline subflow has to verify its parent before that flush
 * lands. Deliberately NOT the `runs_metadata:` hash: `workerRpc.uploadRunLog` merges into that
 * one with an engine-supplied runId/projectId and no ownership check, so it cannot carry an
 * authorization decision.
 */
export const getPendingRunOwnerKey = (runId: ApId): string => `pending_run_owner:${runId}`
