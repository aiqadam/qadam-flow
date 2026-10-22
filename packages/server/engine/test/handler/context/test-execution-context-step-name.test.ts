import { FlowAction, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState, RouterExecutionType } from '@aiqadam/shared'
import { testExecutionContext } from '../../../src/lib/handler/context/test-execution-context'
import { buildQadamAction, buildRouterWithOneCondition, generateMockEngineConstants } from '../test-helper'

// #489: a step named `constructor` (or `toString`, `valueOf`, `hasOwnProperty`) with no own entry
// in `sampleData` must resolve to "no sample output", not to the native function Object.prototype
// happens to have under that name.
describe('testExecutionContext — prototype-named step', () => {
    it('leaves output undefined for a step named constructor with no sample data', async () => {
        const action = buildQadamAction({
            name: 'constructor',
            qadamName: '@aiqadam/qadam-data-mapper',
            actionName: 'advanced_mapping',
            input: {},
        })

        const context = await buildContext({ action, sampleData: {} })

        expect(context.getStepOutput('constructor')?.output).toBeUndefined()
    })

    it('leaves output undefined for a router named toString with no sample data', async () => {
        const action: FlowAction = {
            ...buildRouterWithOneCondition({ children: [], conditions: [null], executionType: RouterExecutionType.EXECUTE_FIRST_MATCH }),
            name: 'toString',
        }

        const context = await buildContext({ action, sampleData: {} })

        expect(context.getStepOutput('toString')?.output).toBeUndefined()
    })

    // The shape the worker hands over once `sampleData` survives `JobData.parse`: JSON-parsed, so
    // `__proto__` is an own key rather than the prototype.
    it('uses the own sample data of a step named __proto__', async () => {
        const action = buildQadamAction({
            name: '__proto__',
            qadamName: '@aiqadam/qadam-data-mapper',
            actionName: 'advanced_mapping',
            input: {},
        })

        const context = await buildContext({ action, sampleData: JSON.parse('{"__proto__":{"fromProto":true}}') })

        expect(context.getStepOutput('__proto__')?.output).toEqual({ fromProto: true })
    })
})

async function buildContext({ action, sampleData }: { action: FlowAction, sampleData: Record<string, unknown> }): ReturnType<typeof testExecutionContext.stateFromFlowVersion> {
    const trigger: FlowTrigger = {
        name: 'trigger',
        displayName: 'Trigger',
        type: FlowTriggerType.EMPTY,
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        settings: {},
        nextAction: action,
    }
    const flowVersion: FlowVersion = {
        id: 'flowVersionId',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flowId',
        displayName: 'Test Flow',
        trigger,
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
    return testExecutionContext.stateFromFlowVersion({
        flowVersion,
        projectId: 'projectId',
        apiUrl: 'http://127.0.0.1:3000/',
        engineToken: 'engineToken',
        sampleData,
        engineConstants: generateMockEngineConstants({ stepNames: ['trigger', action.name] }),
    })
}
