import { FlowRunStatus } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { REDACTED_VALUE } from '../../src/lib/helper/log-redaction'
import { buildQadamAction, generateMockEngineConstants } from './test-helper'

describe('step log redaction across a run', () => {
    it('keeps the live output readable by the next step while the logged copy is redacted', async () => {
        const constants = generateMockEngineConstants({
            stepNames: ['step_1', 'step_2'],
            stepLogPolicy: new Map([['step_1', { logInput: true, logOutput: false }]]),
        })
        let state = FlowExecutorContext.empty({ stepLogPolicy: constants.stepLogPolicy })

        state = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_1',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{ 1 + 2 }}' } },
            }),
            executionState: state,
            constants,
        })
        state = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_2',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{ step_1.output.key }}' } },
            }),
            executionState: state,
            constants,
        })

        expect(state.verdict).toStrictEqual({ status: FlowRunStatus.RUNNING })
        expect(state.getStepOutput('step_1')?.output).toEqual({ key: 3 })
        expect(state.getStepOutput('step_2')?.output).toEqual({ key: 3 })
        expect(state.stepsForLog().step_1.output).toBe(REDACTED_VALUE)
        expect(state.stepsForLog().step_2.output).toEqual({ key: 3 })
    })
})
