import { FlowRunStatus } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'

const { mockUploadRunLog, mockUpload } = vi.hoisted(() => ({
    mockUploadRunLog: vi.fn().mockResolvedValue(undefined),
    mockUpload: vi.fn().mockResolvedValue({ fileId: 'logs', readUrl: 'http://x' }),
}))
vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({ uploadRunLog: mockUploadRunLog, updateRunProgress: vi.fn() }),
    },
}))
vi.mock('../../src/lib/engine-file-api', () => ({
    engineFileApi: { upload: mockUpload, download: vi.fn() },
}))

import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowRunProgressReporter } from '../../src/lib/helper/flow-run-progress-reporter'
import { generateMockEngineConstants } from '../handler/test-helper'

// #387: a loop iteration's verdict is not the run's. A failed item the loop goes on from must not
// reach the server as a FAILED run in the next flush — that fails a subflow's parent and fires the
// run-finished side effects while the run is still going.
describe('flowRunProgressReporter — loop iteration forks', () => {
    it('reports a failed iteration fork as a running run', async () => {
        const failedFork = FlowExecutorContext.empty()
            .forkForIteration({ loopName: 'loop', iteration: 0, concurrent: false })
            .setVerdict({ status: FlowRunStatus.FAILED, failedStep: { name: 'send', displayName: 'Send', message: 'Too Many Requests' } })

        await flowRunProgressReporter.sendUpdate({ engineConstants: generateMockEngineConstants({ logsFileId: 'logs' }), flowExecutorContext: failedFork })
        await flowRunProgressReporter.backup()

        expect(mockUploadRunLog).toHaveBeenCalledWith(expect.objectContaining({ status: FlowRunStatus.RUNNING, failedStep: undefined }))
    })
})
