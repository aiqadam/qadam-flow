import { PackageType, QadamType } from '../../../src/lib/automation/qadams/qadam'
import { ExecuteExtractQadamMetadataJobData, JobData, WorkerJobType } from '../../../src/lib/automation/workers/job-data'

describe('EXECUTE_EXTRACT_PIECE_INFORMATION job data', () => {
    // The API builds the job with `projectId: undefined`; JSON drops the key on the way to the
    // worker, and zod 4.6 stopped treating a missing key as `z.undefined()`.
    it('parses the job as the worker receives it, with no projectId key', () => {
        const received = JSON.parse(JSON.stringify(createExtractJob()))

        expect(Object.keys(received)).not.toContain('projectId')
        expect(JobData.safeParse(received).success).toBe(true)
    })

    it('still parses the job with an explicit undefined projectId', () => {
        expect(JobData.safeParse(createExtractJob()).success).toBe(true)
    })

    it('rejects a job that names a project', () => {
        expect(ExecuteExtractQadamMetadataJobData.safeParse({ ...createExtractJob(), projectId: 'proj-1' }).success).toBe(false)
    })
})

function createExtractJob(): ExecuteExtractQadamMetadataJobData {
    return {
        schemaVersion: 4,
        jobType: WorkerJobType.EXECUTE_EXTRACT_PIECE_INFORMATION,
        projectId: undefined,
        platformId: 'plat-1',
        qadam: {
            qadamName: '@aiqadam/qadam-test',
            qadamVersion: '0.1.0',
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
        },
        requestId: 'req-1',
        webserverId: 'ws-1',
    }
}
