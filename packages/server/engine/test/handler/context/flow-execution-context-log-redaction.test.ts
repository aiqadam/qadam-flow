import { FlowActionType, FlowRunStatus, GenericStepOutput, StepOutputStatus, StepOutputType } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { uploadMock } = vi.hoisted(() => ({
    uploadMock: vi.fn(async () => ({ fileId: 'slice-file', readUrl: 'http://example.com/slice' })),
}))

vi.mock('../../../src/lib/engine-file-api', () => ({
    engineFileApi: {
        upload: uploadMock,
        download: vi.fn(),
    },
}))

import { FlowExecutorContext } from '../../../src/lib/handler/context/flow-execution-context'
import { logRedaction, REDACTED_VALUE } from '../../../src/lib/helper/log-redaction'

const engineApi = { engineToken: 'engine-token', internalApiUrl: 'http://127.0.0.1:1/' }
const bigOutput = { data: 'x'.repeat(40 * 1024) }

beforeEach(() => {
    uploadMock.mockClear()
})

describe('FlowExecutorContext step log redaction', () => {
    it('does not slice an output that is not logged, and redacts it in the logged copy', async () => {
        const ctx = FlowExecutorContext.empty({
            engineApi,
            stepLogPolicy: new Map([['big', { logInput: true, logOutput: false }]]),
        })
        const next = await ctx.upsertStep('big', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: bigOutput,
        }))

        expect(uploadMock).not.toHaveBeenCalled()
        expect(next.steps.big.outputType).toBeUndefined()
        expect(next.steps.big.output).toEqual(bigOutput)
        expect(next.stepsForLog().big.output).toBe(REDACTED_VALUE)
    })

    it('still slices a large output when it is logged', async () => {
        const ctx = FlowExecutorContext.empty({ engineApi })
        const next = await ctx.upsertStep('big', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: bigOutput,
        }))

        expect(uploadMock).toHaveBeenCalledTimes(1)
        expect(next.steps.big.outputType).toBe(StepOutputType.SLICE)
        expect(next.stepsForLog().big).toBe(next.steps.big)
    })

    it('redacts the input at write time, leaving the executed input untouched', async () => {
        const ctx = FlowExecutorContext.empty({
            stepLogPolicy: new Map([['step', { logInput: false, logOutput: true }]]),
        })
        const next = await ctx.upsertStep('step', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: { token: 'secret' },
            output: {},
        }))

        expect(next.steps.step.input).toBe(REDACTED_VALUE)
        expect(next.stepsForLog().step.input).toBe(REDACTED_VALUE)
    })

    it('keeps outputs raw while the run is paused so RESUME can hydrate them', async () => {
        const ctx = FlowExecutorContext.empty({
            stepLogPolicy: new Map([['step', { logInput: true, logOutput: false }]]),
        })
        const withStep = await ctx.upsertStep('step', GenericStepOutput.create({
            type: FlowActionType.CODE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: { token: 'secret' },
        }))
        const paused = withStep.setVerdict({ status: FlowRunStatus.PAUSED })

        expect(logRedaction.isOutputRedactionEnabled({ status: FlowRunStatus.PAUSED })).toBe(false)
        expect(paused.stepsForLog().step.output).toEqual({ token: 'secret' })
        expect(withStep.setVerdict({ status: FlowRunStatus.SUCCEEDED, stopResponse: undefined }).stepsForLog().step.output).toBe(REDACTED_VALUE)
    })
})
