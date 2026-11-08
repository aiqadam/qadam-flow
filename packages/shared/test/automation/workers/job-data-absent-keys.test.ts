import { z } from 'zod'
import { PredefinedInputField } from '../../../src/lib/automation/agents/tools'
import { EngineHttpResponse, TriggerHookType, TriggerPayload } from '../../../src/lib/automation/engine/engine-operation'
import { ResolveInlineFlowRequest, SendFlowResponseRequest } from '../../../src/lib/automation/engine/requests'
import { JoinSlotResult } from '../../../src/lib/automation/flow-run/waitpoint'
import { SaveSampleDataRequest, StepRunResponse } from '../../../src/lib/automation/flows/sample-data'
import { EmptyTrigger } from '../../../src/lib/automation/flows/triggers/trigger'
import { TriggerEventWithPayload } from '../../../src/lib/automation/flows/triggers/trigger-events/trigger-event'
import { SaveTriggerEventRequest } from '../../../src/lib/automation/flows/triggers/trigger-events/trigger-events-dto'
import { QadamOptionRequest } from '../../../src/lib/automation/qadams/dto/qadam-requests'
import { ExecuteTriggerHookJobData, ExecuteValidateAuthJobData, InlineJobPayload, WorkerJobType } from '../../../src/lib/automation/workers/job-data'
import { ApMultipartFile } from '../../../src/lib/core/common/multipart-file'

// JSON drops `undefined`-valued keys, so a field that may legitimately be undefined reaches the
// parser as a missing key. zod 4.3 accepted a missing key for bare `z.unknown()` / `z.any()`;
// zod 4.6 rejects it unless the field is declared `.optional()` (#949). Every field here crossed
// a JSON boundary as `undefined` before that change and must keep parsing after it.
describe('schemas that carry an undefined-able field across JSON', () => {
    it.each(absentKeyCases())('$name accepts a missing $field', ({ schema, field }) => {
        const result = schema.pick({ [field]: true }).safeParse(jsonRoundTrip({ [field]: undefined }))

        expect(result.success).toBe(true)
    })

    it('parses a trigger-hook job whose webhook payload has no body', () => {
        const job = {
            jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
            platformId: 'platform',
            projectId: 'project',
            schemaVersion: 10,
            flowId: 'flow',
            flowVersionId: 'flow-version',
            test: false,
            hookType: TriggerHookType.HANDSHAKE,
            triggerPayload: { body: undefined, headers: {}, queryParams: { challenge: 'x' } },
            requestId: 'request',
            webserverId: 'webserver',
        }

        const parsed = ExecuteTriggerHookJobData.parse(jsonRoundTrip(job))

        expect(parsed.triggerPayload?.queryParams).toEqual({ challenge: 'x' })
        expect(parsed.triggerPayload?.body).toBeUndefined()
    })
})

function absentKeyCases(): AbsentKeyCase[] {
    return [
        { name: 'TriggerPayload', schema: TriggerPayload, field: 'body' },
        { name: 'EngineHttpResponse', schema: EngineHttpResponse, field: 'body' },
        { name: 'ResolveInlineFlowRequest', schema: ResolveInlineFlowRequest, field: 'payload' },
        { name: 'SendFlowResponseRequest.runResponse', schema: SendFlowResponseRequest.shape.runResponse, field: 'body' },
        { name: 'JoinSlotResult', schema: JoinSlotResult, field: 'data' },
        { name: 'SaveSampleDataRequest', schema: SaveSampleDataRequest, field: 'payload' },
        { name: 'StepRunResponse', schema: StepRunResponse, field: 'input' },
        { name: 'StepRunResponse', schema: StepRunResponse, field: 'output' },
        { name: 'TriggerEventWithPayload', schema: TriggerEventWithPayload, field: 'payload' },
        { name: 'SaveTriggerEventRequest', schema: SaveTriggerEventRequest, field: 'mockData' },
        { name: 'EmptyTrigger', schema: EmptyTrigger, field: 'settings' },
        { name: 'QadamOptionRequest', schema: QadamOptionRequest, field: 'input' },
        { name: 'InlineJobPayload', schema: InlineJobPayload, field: 'value' },
        { name: 'ExecuteValidateAuthJobData', schema: ExecuteValidateAuthJobData, field: 'connectionValue' },
        { name: 'PredefinedInputField', schema: PredefinedInputField, field: 'value' },
        { name: 'ApMultipartFile', schema: ApMultipartFile, field: 'data' },
    ]
}

function jsonRoundTrip(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}

type AbsentKeyCase = {
    name: string
    schema: z.ZodObject
    field: string
}
