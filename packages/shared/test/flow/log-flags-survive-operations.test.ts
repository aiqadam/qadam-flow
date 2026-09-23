import {
    FlowActionType,
    FlowOperationRequest,
    flowOperations,
    FlowOperationType,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
} from '../../src'

const baseFlowVersion: FlowVersion = {
    notes: [],
    id: 'pj0KQ7Aypoa9OQGHzmKDl',
    created: '2023-05-24T00:16:41.353Z',
    updated: '2023-05-24T00:16:41.353Z',
    flowId: 'lod6JEdKyPlvrnErdnrGa',
    displayName: 'Log flag survival',
    updatedBy: '',
    agentIds: [],
    trigger: {
        name: 'trigger',
        type: FlowTriggerType.PIECE,
        valid: true,
        settings: {
            input: {
                cronExpression: '25 10 * * 0,1,2,3,4',
            },
            qadamName: 'schedule',
            qadamVersion: '0.0.2',
            propertySettings: {},
            triggerName: 'cron_expression',
        },
        displayName: 'Cron Expression',
    },
    valid: true,
    state: FlowVersionState.DRAFT,
    connectionIds: [],
}

// #505 review finding 5: every ap_update_trigger / ap_update_step MCP test mocks
// `flowService.update`, so a revert of `logOutput: request.logOutput` in
// `update-trigger.ts`/`add-action.ts` fails nothing in that suite. These drive the real
// `flowOperations.apply` pipeline instead, so the flag's actual persistence is under test.
describe('logInput / logOutput survive flowOperations.apply', () => {
    it('UPDATE_TRIGGER: logOutput: false on the request lands on the resulting trigger', () => {
        const operation: FlowOperationRequest = {
            type: FlowOperationType.UPDATE_TRIGGER,
            request: {
                ...baseFlowVersion.trigger,
                logOutput: false,
            },
        }

        const result = flowOperations.apply(baseFlowVersion, operation)

        expect(result.trigger.logOutput).toBe(false)
    })

    it('UPDATE_TRIGGER: an explicit true on the request turns logging back on', () => {
        const flowVersionWithLoggingOff: FlowVersion = {
            ...baseFlowVersion,
            trigger: { ...baseFlowVersion.trigger, logOutput: false },
        }
        const operation: FlowOperationRequest = {
            type: FlowOperationType.UPDATE_TRIGGER,
            request: {
                ...flowVersionWithLoggingOff.trigger,
                logOutput: true,
            },
        }

        const result = flowOperations.apply(flowVersionWithLoggingOff, operation)

        expect(result.trigger.logOutput).toBe(true)
    })

    it('ADD_ACTION: logInput/logOutput false on the request land on the resulting action', () => {
        const operation: FlowOperationRequest = {
            type: FlowOperationType.ADD_ACTION,
            request: {
                parentStep: 'trigger',
                action: {
                    name: 'step_1',
                    displayName: 'Code',
                    type: FlowActionType.CODE,
                    valid: true,
                    logInput: false,
                    logOutput: false,
                    settings: {
                        sourceCode: {
                            code: 'test',
                            packageJson: '{}',
                        },
                        input: {},
                    },
                },
            },
        }

        const result = flowOperations.apply(baseFlowVersion, operation)

        const addedStep = result.trigger.nextAction
        expect(addedStep?.logInput).toBe(false)
        expect(addedStep?.logOutput).toBe(false)
    })
})
