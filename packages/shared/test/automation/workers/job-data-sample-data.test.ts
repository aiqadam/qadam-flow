import { StreamStepProgress } from '../../../src/lib/automation/engine/engine-operation'
import { ExecutionType } from '../../../src/lib/automation/flow-run/execution/execution-output'
import { RunEnvironment } from '../../../src/lib/automation/flow-run/flow-run'
import { ExecutePropertyJobData, JobData, WorkerJobType } from '../../../src/lib/automation/workers/job-data'

describe('JobData sample data', () => {
    // JSON.parse is how the job arrives from Redis, and it creates `__proto__` as an own key — the
    // exact shape a step literally named `__proto__` produces (#489).
    it('keeps a step named __proto__ when the worker parses an EXECUTE_FLOW job', () => {
        const job = { ...createBeginExecuteFlowJob(), sampleData: parseSampleDataWithProtoStep() }

        const parsed = JobData.parse(job)

        expect(parsed.jobType).toBe(WorkerJobType.EXECUTE_FLOW)
        const sampleData = parsed.jobType === WorkerJobType.EXECUTE_FLOW ? parsed.sampleData : undefined
        expect(sampleData).toBeDefined()
        expect(Object.keys(sampleData ?? {})).toEqual(['__proto__', 'step_1'])
        expect(Object.getOwnPropertyDescriptor(sampleData, '__proto__')?.value).toEqual({ fromProto: true })
        expect(Object.getPrototypeOf(sampleData)).toBe(Object.prototype)
    })

    it('keeps a step named __proto__ in EXECUTE_PROPERTY sample data', () => {
        const parsed = ExecutePropertyJobData.shape.sampleData.parse(parseSampleDataWithProtoStep())

        expect(Object.keys(parsed)).toEqual(['__proto__', 'step_1'])
        expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({ fromProto: true })
    })

    it('still accepts a job without sample data', () => {
        const { sampleData: _omitted, ...job } = createBeginExecuteFlowJob()

        expect(JobData.safeParse(job).success).toBe(true)
    })

    it.each([
        ['an array', [{ value: 1 }]],
        ['null', null],
        ['a string', 'step_1'],
    ])('rejects sample data that is %s', (_label, sampleData) => {
        expect(JobData.safeParse({ ...createBeginExecuteFlowJob(), sampleData }).success).toBe(false)
    })
})

function createBeginExecuteFlowJob(): Record<string, unknown> {
    return {
        projectId: 'project-id',
        platformId: 'platform-id',
        jobType: WorkerJobType.EXECUTE_FLOW,
        environment: RunEnvironment.TESTING,
        schemaVersion: 10,
        flowId: 'flow-id',
        flowVersionId: 'flow-version-id',
        runId: 'run-id',
        payload: { type: 'inline', value: {} },
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: 'step_2',
        sampleData: { step_1: { value: 1 } },
        logsFileId: 'logs-file-id',
        executionType: ExecutionType.BEGIN,
    }
}

function parseSampleDataWithProtoStep(): unknown {
    return JSON.parse('{"__proto__":{"fromProto":true},"step_1":{"value":1}}')
}
