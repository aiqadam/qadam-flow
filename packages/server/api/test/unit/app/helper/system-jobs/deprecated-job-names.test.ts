import { DEPRECATED_SYSTEM_JOB_NAMES, SystemJobName } from '../../../../../src/app/helper/system-jobs/common'

// The boot cleanup deletes, and the worker silently drops, every job under a deprecated name. A live
// job name on that list would be unscheduled on every boot and never run.
describe('DEPRECATED_SYSTEM_JOB_NAMES', () => {
    it('should not contain any current SystemJobName', () => {
        const current: string[] = Object.values(SystemJobName)
        expect(current.filter(name => DEPRECATED_SYSTEM_JOB_NAMES.includes(name))).toEqual([])
    })
})
