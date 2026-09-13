import { FlowRunStatus, StepOutputStatus } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { flowExecutor } from '../../src/lib/handler/flow-executor'
import { buildQadamAction, generateMockEngineConstants } from './test-helper'

// #392: `{{VAR}}` resolved to an empty string and the step succeeded with a wrong value. The run
// must fail instead, and it must fail *at the step that holds the reference* — an unattributed
// INTERNAL_ERROR leaves a 70-step flow with nothing to go on.
describe('unresolved template reference', () => {
    it('fails the referencing step rather than resolving to an empty string', async () => {
        const result = await flowExecutor.execute({
            action: buildQadamAction({
                name: 'sign_payload',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{SIGNING_KEY}}' } },
            }),
            executionState: FlowExecutorContext.empty(),
            constants: generateMockEngineConstants({ stepNames: ['trigger', 'sign_payload'] }),
        })

        expect(result.verdict.status).toBe(FlowRunStatus.FAILED)
        expect(result.verdict.failedStep?.name).toBe('sign_payload')
        expect(result.steps.sign_payload.status).toBe(StepOutputStatus.FAILED)
        expect(result.steps.sign_payload.errorMessage).toContain('{{variables[\'SIGNING_KEY\']}}')
    })
})
