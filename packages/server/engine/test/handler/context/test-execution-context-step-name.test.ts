import { FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState } from '@aiqadam/shared'
import { testExecutionContext } from '../../../src/lib/handler/context/test-execution-context'
import { buildQadamAction, generateMockEngineConstants } from '../test-helper'

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

        const context = await testExecutionContext.stateFromFlowVersion({
            flowVersion,
            projectId: 'projectId',
            apiUrl: 'http://127.0.0.1:3000/',
            engineToken: 'engineToken',
            sampleData: {},
            engineConstants: generateMockEngineConstants({ stepNames: ['trigger', 'constructor'] }),
        })

        expect(context.getStepOutput('constructor')?.output).toBeUndefined()
    })
})
