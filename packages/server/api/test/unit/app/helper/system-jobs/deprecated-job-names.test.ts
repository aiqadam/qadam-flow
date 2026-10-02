import { DEPRECATED_SYSTEM_JOB_NAMES, deprecatedSystemJobs, SystemJobName } from '../../../../../src/app/helper/system-jobs/common'

// The boot cleanup deletes, and the worker silently drops, every job under a deprecated name. A live
// job name it matched would be unscheduled on every boot and never run.
describe('deprecatedSystemJobs.isDeprecated', () => {
    it('should match every listed name', () => {
        expect(DEPRECATED_SYSTEM_JOB_NAMES.filter(name => !deprecatedSystemJobs.isDeprecated(name))).toEqual([])
    })

    it('should not match any current SystemJobName', () => {
        const current: string[] = Object.values(SystemJobName)
        expect(current.filter(name => deprecatedSystemJobs.isDeprecated(name))).toEqual([])
    })

    it('should match exactly, not by prefix', () => {
        expect(deprecatedSystemJobs.isDeprecated('usage-report-v2')).toBe(false)
        expect(deprecatedSystemJobs.isDeprecated('pieces-sync-2')).toBe(false)
    })
})
