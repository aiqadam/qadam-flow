import { FlowRunStatus, RunInternalErrorSource, WebsocketClientEvent } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emit, to, addRunsMetadata, exists, getDataOrUndefined, save } = vi.hoisted(() => {
    const emit = vi.fn()
    return {
        emit,
        to: vi.fn(() => ({ emit })),
        addRunsMetadata: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn(),
        getDataOrUndefined: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
    }
})

vi.mock('../../../../../src/app/core/websockets.service', () => ({
    websocketService: { to },
}))

vi.mock('../../../../../src/app/flows/flow-run/flow-runs-queue', () => ({
    runsMetadataQueue: () => ({ add: addRunsMetadata }),
}))

vi.mock('../../../../../src/app/file/file.service', () => ({
    fileService: () => ({ exists, getDataOrUndefined, save }),
}))

vi.mock('../../../../../src/app/project/project-service', () => ({
    projectService: () => ({ getPlatformId: vi.fn().mockResolvedValue('platform-1') }),
}))

import { createHandlers } from '../../../../../src/app/workers/rpc/worker-rpc-service'

const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

const snapshot = {
    runId: 'run-1',
    projectId: 'project-1',
    status: FlowRunStatus.RUNNING,
    logsFileId: 'logs-1',
}

describe('workerRpc#uploadRunLog', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    // #580: the run view refetches on this instead of waiting for its next poll.
    it('tells the run\'s own project room that the run has a new snapshot, and nothing else', async () => {
        exists.mockResolvedValue(true)

        await createHandlers(log).uploadRunLog(snapshot)

        expect(to).toHaveBeenCalledTimes(1)
        expect(to).toHaveBeenCalledWith('project-1')
        expect(emit).toHaveBeenCalledTimes(1)
        expect(emit).toHaveBeenCalledWith(WebsocketClientEvent.FLOW_RUN_PROGRESS, { runId: 'run-1' })
    })

    it('checks the logs file row without downloading the log on the happy path', async () => {
        exists.mockResolvedValue(true)

        await createHandlers(log).uploadRunLog(snapshot)

        expect(exists).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1', fileId: 'logs-1' }))
        expect(getDataOrUndefined).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
    })

    it('still creates an empty logs file when the row is missing', async () => {
        exists.mockResolvedValue(false)

        await createHandlers(log).uploadRunLog(snapshot)

        expect(getDataOrUndefined).not.toHaveBeenCalled()
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'logs-1', projectId: 'project-1' }))
    })

    it('still reads the existing log to merge an internal error into it', async () => {
        getDataOrUndefined.mockResolvedValue({
            data: Buffer.from(JSON.stringify({ executionState: { steps: { trigger: {} }, tags: [] } })),
        })

        await createHandlers(log).uploadRunLog({
            ...snapshot,
            status: FlowRunStatus.INTERNAL_ERROR,
            internalError: { source: RunInternalErrorSource.WORKER, message: 'boom', occurredAt: new Date().toISOString() },
        })

        expect(exists).not.toHaveBeenCalled()
        expect(getDataOrUndefined).toHaveBeenCalledTimes(1)
        expect(save).toHaveBeenCalledTimes(1)
    })
})
