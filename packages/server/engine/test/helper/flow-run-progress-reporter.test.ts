import { FlowActionType, FlowRunStatus, GenericStepOutput, StepOutputStatus, StepRunResponse, StreamStepProgress, UpdateRunProgressRequest, UploadRunLogsRequest } from '@aiqadam/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'

const { uploadRunLogMock, updateRunProgressMock, updateStepProgressMock } = vi.hoisted(() => ({
    uploadRunLogMock: vi.fn<(request: UploadRunLogsRequest) => Promise<void>>(async () => undefined),
    updateRunProgressMock: vi.fn<(request: UpdateRunProgressRequest) => Promise<void>>(async () => undefined),
    updateStepProgressMock: vi.fn<(request: { projectId: string, stepResponse: StepRunResponse }) => Promise<void>>(async () => undefined),
}))

vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({
            uploadRunLog: uploadRunLogMock,
            updateRunProgress: updateRunProgressMock,
            updateStepProgress: updateStepProgressMock,
        }),
    },
}))

const { retryingFetchMock } = vi.hoisted(() => ({
    retryingFetchMock: vi.fn(async (_params: { url: string | URL, policy?: RetryPolicy }) => new Response(JSON.stringify({ readUrl: 'https://mock.read.url/logs' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    })),
}))

vi.mock('../../src/lib/retrying-fetch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/retrying-fetch')>()
    return { retryingFetch: { ...actual.retryingFetch, fetch: retryingFetchMock } }
})

import { flowRunProgressReporter } from '../../src/lib/helper/flow-run-progress-reporter'
import { retryingFetch, RetryPolicy } from '../../src/lib/retrying-fetch'
import { generateMockEngineConstants } from '../handler/test-helper'

const buildUpdateParams = ({ status }: { status: FlowRunStatus }) => {
    const engineConstants = generateMockEngineConstants({
        streamStepProgress: StreamStepProgress.NONE,
        engineToken: 'mock-engine-token',
        internalApiUrl: 'http://127.0.0.1:65535/',
        logsFileId: 'logs-1',
    })
    const flowExecutorContext = new FlowExecutorContext()
    flowExecutorContext.verdict = status === FlowRunStatus.RUNNING
        ? { status: FlowRunStatus.RUNNING }
        : { status: FlowRunStatus.SUCCEEDED, stopResponse: undefined }
    return { engineConstants, flowExecutorContext }
}

const uploadStatuses = (): FlowRunStatus[] =>
    uploadRunLogMock.mock.calls.map(([request]) => request.status)

const lastUploadStatus = (): FlowRunStatus | undefined => uploadStatuses().at(-1)

describe('flow-run-progress-reporter backup ordering', () => {
    beforeEach(() => {
        uploadRunLogMock.mockClear()
        updateRunProgressMock.mockClear()
    })

    afterEach(async () => {
        await flowRunProgressReporter.shutdown()
    })

    it('the last write wins: a periodic backup firing after the terminal sendUpdate cannot overwrite SUCCEEDED', async () => {
        flowRunProgressReporter.init()

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.SUCCEEDED }))
        await flowRunProgressReporter.backup()

        // Simulate the periodic loop firing one more time after the terminal
        // state is set. It must read the current latest state (SUCCEEDED) — not
        // a stale RUNNING — so the run never reverts to running.
        await flowRunProgressReporter.backup()

        expect(lastUploadStatus()).toBe(FlowRunStatus.SUCCEEDED)
        expect(uploadStatuses()).not.toContain(FlowRunStatus.RUNNING)
    })

    it('preserves order under concurrent backup calls', async () => {
        flowRunProgressReporter.init()

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        const firstBackup = flowRunProgressReporter.backup()
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.SUCCEEDED }))
        const secondBackup = flowRunProgressReporter.backup()
        await Promise.all([firstBackup, secondBackup])

        expect(lastUploadStatus()).toBe(FlowRunStatus.SUCCEEDED)
        const allStatuses = uploadStatuses()
        const terminalIndex = allStatuses.indexOf(FlowRunStatus.SUCCEEDED)
        const runningAfterTerminal = allStatuses
            .slice(terminalIndex + 1)
            .some((s) => s === FlowRunStatus.RUNNING)
        expect(runningAfterTerminal).toBe(false)
    })

    it('still uploads RUNNING progress while the flow is in progress', async () => {
        flowRunProgressReporter.init()

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.backup()

        expect(lastUploadStatus()).toBe(FlowRunStatus.RUNNING)
    })

    it('clears state on shutdown so the next run starts clean', async () => {
        flowRunProgressReporter.init()
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.SUCCEEDED }))
        await flowRunProgressReporter.backup()
        await flowRunProgressReporter.shutdown()

        flowRunProgressReporter.init()
        const before = uploadRunLogMock.mock.calls.length
        await flowRunProgressReporter.backup()
        expect(uploadRunLogMock.mock.calls.length).toBe(before)

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.backup()
        expect(lastUploadStatus()).toBe(FlowRunStatus.RUNNING)
    })
})

// #580: a production run reaches the live run view only through these snapshots.
// The loop itself is not started here: its real timer could fire mid-test and add an upload. These
// tests drive the two calls it makes, flushIfDirty and nextFlushDelayMs.
describe('flow-run-progress-reporter periodic flush', () => {
    beforeEach(() => {
        uploadRunLogMock.mockClear()
        updateRunProgressMock.mockClear()
    })

    afterEach(async () => {
        await flowRunProgressReporter.shutdown()
    })

    it('uploads a periodic snapshot only after something changed', async () => {
        await flowRunProgressReporter.flushIfDirty()
        expect(uploadRunLogMock).not.toHaveBeenCalled()

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.flushIfDirty()
        expect(uploadRunLogMock).toHaveBeenCalledTimes(1)

        // A long-waiting step sends no updates: the loop must not re-upload the same log.
        await flowRunProgressReporter.flushIfDirty()
        await flowRunProgressReporter.flushIfDirty()
        expect(uploadRunLogMock).toHaveBeenCalledTimes(1)

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.flushIfDirty()
        expect(uploadRunLogMock).toHaveBeenCalledTimes(2)
    })

    it('an explicit backup uploads even when nothing changed since the last flush', async () => {
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.SUCCEEDED }))
        await flowRunProgressReporter.flushIfDirty()
        await flowRunProgressReporter.backup()

        expect(uploadRunLogMock).toHaveBeenCalledTimes(2)
    })

    it('an explicit backup clears the dirty flag, so the loop does not upload the same state again', async () => {
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.backup()
        await flowRunProgressReporter.flushIfDirty()

        expect(uploadRunLogMock).toHaveBeenCalledTimes(1)
    })

    it('keeps the snapshot dirty when the upload fails, so the next tick retries it', async () => {
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        uploadRunLogMock.mockRejectedValueOnce(new Error('api down'))

        await expect(flowRunProgressReporter.flushIfDirty()).rejects.toThrow()
        await flowRunProgressReporter.flushIfDirty()

        expect(uploadRunLogMock).toHaveBeenCalledTimes(2)
    })

    it('flushes a small log every 2 s', async () => {
        expect(flowRunProgressReporter.nextFlushDelayMs()).toBe(2000)

        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.flushIfDirty()

        expect(flowRunProgressReporter.nextFlushDelayMs()).toBe(2000)
    })

    it('keeps the 15 s cadence once the serialized log is above 1 MB, and resets on shutdown', async () => {
        const { engineConstants } = buildUpdateParams({ status: FlowRunStatus.RUNNING })
        const flowExecutorContext = await FlowExecutorContext.empty({ slicingEnabled: false }).upsertStep('big_step', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: { big: 'x'.repeat(1_100_000) },
        }))

        await flowRunProgressReporter.sendUpdate({ engineConstants, flowExecutorContext })
        await flowRunProgressReporter.flushIfDirty()
        expect(flowRunProgressReporter.nextFlushDelayMs()).toBe(15000)

        await flowRunProgressReporter.shutdown()
        expect(flowRunProgressReporter.nextFlushDelayMs()).toBe(2000)
    })
})

// #595: the final snapshot is the run's result and waits out an app restart; a periodic or initial
// one holds the lock every step's progress update needs, so it gives up sooner.
describe('flow-run-progress-reporter upload retry budget', () => {
    beforeEach(() => {
        retryingFetchMock.mockClear()
    })

    afterEach(async () => {
        await flowRunProgressReporter.shutdown()
    })

    const lastUploadPolicy = (): RetryPolicy | undefined => retryingFetchMock.mock.calls.at(-1)?.[0].policy

    it('gives the final backup the full budget', async () => {
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.SUCCEEDED }))
        await flowRunProgressReporter.backup()

        expect(retryingFetchMock).toHaveBeenCalledTimes(1)
        expect(lastUploadPolicy()).toBe(retryingFetch.defaultPolicy)
        expect(retryingFetch.defaultPolicy.budgetMs).toBe(60_000)
    })

    it('gives a periodic flush and a best-effort backup the short budget', async () => {
        await flowRunProgressReporter.sendUpdate(buildUpdateParams({ status: FlowRunStatus.RUNNING }))
        await flowRunProgressReporter.flushIfDirty()
        expect(lastUploadPolicy()).toBe(retryingFetch.bestEffortPolicy)

        await flowRunProgressReporter.backup({ bestEffort: true })
        expect(lastUploadPolicy()).toBe(retryingFetch.bestEffortPolicy)
        expect(retryingFetch.bestEffortPolicy.budgetMs).toBeLessThan(retryingFetch.defaultPolicy.budgetMs)
    })
})

describe('flow-run-progress-reporter slicing in single-step test mode', () => {
    beforeEach(() => {
        uploadRunLogMock.mockClear()
        updateRunProgressMock.mockClear()
    })

    afterEach(async () => {
        await flowRunProgressReporter.shutdown()
    })

    it('does not slice step outputs when slicingEnabled is false', async () => {
        const engineConstants = generateMockEngineConstants({
            streamStepProgress: StreamStepProgress.WEBSOCKET,
            engineToken: 'mock-engine-token',
            internalApiUrl: 'http://127.0.0.1:65535/',
            logsFileId: 'logs-1',
            stepNameToTest: 'step_emit_big',
        })

        let flowExecutorContext = FlowExecutorContext.empty({
            engineApi: { engineToken: engineConstants.engineToken, internalApiUrl: engineConstants.internalApiUrl },
            slicingEnabled: false,
        })
        flowExecutorContext.verdict = { status: FlowRunStatus.SUCCEEDED, stopResponse: undefined }

        const big = { big: 'x'.repeat(40_000) }
        flowExecutorContext = await flowExecutorContext.upsertStep('step_emit_big', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: big,
        }))

        const stored = flowExecutorContext.steps['step_emit_big']
        expect(stored.outputType).toBeUndefined()
        expect(stored.output).toEqual(big)

        flowRunProgressReporter.init()
        await flowRunProgressReporter.sendUpdate({ engineConstants, flowExecutorContext })
        await flowRunProgressReporter.backup()

        const stepResponse = uploadRunLogMock.mock.calls.at(-1)![0].stepResponse
        expect(stepResponse!.output).toEqual(big)
    })

    it('streams the original payload via updateStepProgress even when upsertStep slices the output', async () => {
        const engineConstants = generateMockEngineConstants({
            streamStepProgress: StreamStepProgress.WEBSOCKET,
            engineToken: 'mock-engine-token',
            internalApiUrl: 'http://127.0.0.1:65535/',
            logsFileId: 'logs-1',
        })

        let flowExecutorContext = FlowExecutorContext.empty({
            engineApi: { engineToken: engineConstants.engineToken, internalApiUrl: engineConstants.internalApiUrl },
            slicingEnabled: true,
        })

        const seedStep = GenericStepOutput.create({
            type: FlowActionType.PIECE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: undefined,
        }) as GenericStepOutput<FlowActionType.PIECE, unknown>

        // Seed the journal so we can read it back and inspect what was stored
        flowExecutorContext = await flowExecutorContext.upsertStep('streaming_step', seedStep)

        const outputContext = flowRunProgressReporter.createOutputContext({
            engineConstants,
            flowExecutorContext,
            stepName: 'streaming_step',
            stepOutput: seedStep,
        })

        const big = { big: 'x'.repeat(40_000) }
        await outputContext.update({ data: big })

        const lastCall = updateStepProgressMock.mock.calls.at(-1)
        expect(lastCall).toBeDefined()
        // The live UI update must carry the actual payload, never the LogSliceRef
        expect(lastCall![0].stepResponse.output).toEqual(big)
    })
})

// #643: an agent tool's one-step execution carries its parent step's real run id, so the reporter
// must not take it for that run.
describe('flow-run-progress-reporter and an agent tool call', () => {
    beforeEach(() => {
        uploadRunLogMock.mockClear()
        updateStepProgressMock.mockClear()
    })

    afterEach(async () => {
        await flowRunProgressReporter.shutdown()
    })

    it('keeps the parent run\'s snapshot when a tool call reports its own step', async () => {
        const parent = buildUpdateParams({ status: FlowRunStatus.RUNNING })
        const toolConstants = EngineConstants.fromAgentToolCall({ parent: parent.engineConstants, insideConcurrentIteration: false })
        const toolContext = await FlowExecutorContext.empty().upsertStep('callFlow', GenericStepOutput.create({
            type: FlowActionType.PIECE,
            status: StepOutputStatus.RUNNING,
            input: {},
        }))

        await flowRunProgressReporter.sendUpdate(parent)
        await flowRunProgressReporter.sendUpdate({ engineConstants: toolConstants, flowExecutorContext: toolContext, stepNameToUpdate: 'callFlow' })
        await flowRunProgressReporter.backup()

        expect(uploadRunLogMock).toHaveBeenCalledTimes(1)
        expect(uploadRunLogMock.mock.calls[0][0]).toMatchObject({ runId: parent.engineConstants.flowRunId, logsFileId: 'logs-1' })
    })

    it('streams nothing for a tool call\'s step under the parent run', async () => {
        const parent = buildUpdateParams({ status: FlowRunStatus.RUNNING })
        const toolConstants = EngineConstants.fromAgentToolCall({ parent: parent.engineConstants, insideConcurrentIteration: false })
        const stepOutput = GenericStepOutput.create({ type: FlowActionType.PIECE, status: StepOutputStatus.RUNNING, input: {} })

        const outputContext = flowRunProgressReporter.createOutputContext({
            engineConstants: toolConstants,
            flowExecutorContext: FlowExecutorContext.empty(),
            stepName: 'callFlow',
            stepOutput,
        })
        await outputContext.update({ data: { partial: true } })

        expect(updateStepProgressMock).not.toHaveBeenCalled()
    })
})
