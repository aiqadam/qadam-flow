import { isNil, PausedFlowTimeoutError } from '@aiqadam/shared'
import dayjs from 'dayjs'

const AP_PAUSED_FLOW_TIMEOUT_DAYS = Number(process.env.AP_PAUSED_FLOW_TIMEOUT_DAYS)

// Shared by the waitpoints a qadam creates and the checkpoints a durable loop takes (#387): a run
// may not be parked further out than the platform keeps paused runs.
export const pausedFlowLimits = {
    assertResumeWithinTimeout(resumeDateTime?: string): void {
        if (isNil(resumeDateTime)) {
            return
        }
        const diffInDays = dayjs(resumeDateTime).diff(dayjs(), 'days')
        if (diffInDays > AP_PAUSED_FLOW_TIMEOUT_DAYS) {
            throw new PausedFlowTimeoutError(undefined, AP_PAUSED_FLOW_TIMEOUT_DAYS)
        }
    },
}
