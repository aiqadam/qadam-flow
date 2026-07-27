import { PlatformId, ProjectId } from '@aiqadam/shared'

export const getPlatformPlanNameKey = (platformId: PlatformId): string => `platform_plan:plan:${platformId}`
export const getConcurrencyPoolSetKey = (poolId: string): string => `active_jobs_set:pool:${poolId}`
export const getProjectMaxConcurrentJobsKey = (projectId: ProjectId): string => `project:max_concurrent_jobs:${projectId}`
