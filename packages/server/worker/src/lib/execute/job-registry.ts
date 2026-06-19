import { EngineResponseStatus, JobData, WorkerJobType } from '@aiqadam/shared'
import { executeFlowJob } from './jobs/execute-flow'
import { executePollingJob } from './jobs/execute-polling'
import { executePropertyJob } from './jobs/execute-property'
import { executeTriggerHookJob } from './jobs/execute-trigger-hook'
import { executeValidationJob } from './jobs/execute-validation'
import { executeWebhookJob } from './jobs/execute-webhook'
import { extractPieceInfoJob } from './jobs/extract-qadam-info'
import { renewWebhookJob } from './jobs/renew-webhook'
import { JobHandler, JobResultKind } from './types'

const chatAgentStub: JobHandler = {
    jobType: WorkerJobType.EXECUTE_CHAT_AGENT,
    async execute() {
        return {
            kind: JobResultKind.FIRE_AND_FORGET,
            status: EngineResponseStatus.OK,
        }
    },
}

const registry: Record<WorkerJobType, JobHandler> = {
    [WorkerJobType.EXECUTE_FLOW]: executeFlowJob,
    [WorkerJobType.EXECUTE_POLLING]: executePollingJob,
    [WorkerJobType.EXECUTE_WEBHOOK]: executeWebhookJob,
    [WorkerJobType.RENEW_WEBHOOK]: renewWebhookJob,
    [WorkerJobType.EXECUTE_TRIGGER_HOOK]: executeTriggerHookJob,
    [WorkerJobType.EXECUTE_PROPERTY]: executePropertyJob,
    [WorkerJobType.EXECUTE_VALIDATION]: executeValidationJob,
    [WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION]: extractPieceInfoJob,
    [WorkerJobType.EXECUTE_CHAT_AGENT]: chatAgentStub,
}

export function getHandler(jobType: WorkerJobType): JobHandler<JobData> {
    return registry[jobType]
}
