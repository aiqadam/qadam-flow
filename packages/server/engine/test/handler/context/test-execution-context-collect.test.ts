import { FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState, LoopOnItemsAction } from '@aiqadam/shared'
import { testExecutionContext } from '../../../src/lib/handler/context/test-execution-context'
import { buildQadamAction, buildSimpleLoopAction, generateMockEngineConstants } from '../test-helper'

// #41: a step tested on its own after a collecting loop sees the shape of `collected`, built from
// the sample data of the loop's body — a loop's sample has no iterations to collect from.
describe('testExecutionContext — loop collect sample', () => {
    it('fills collected with the value for the first item', async () => {
        const body = buildQadamAction({
            name: 'map',
            qadamName: '@aiqadam/qadam-data-mapper',
            actionName: 'advanced_mapping',
            input: {},
        })
        const baseLoop = buildSimpleLoopAction({ name: 'loop', loopItems: '{{ [4, 5] }}', firstLoopAction: body })
        const loop: LoopOnItemsAction = { ...baseLoop, settings: { ...baseLoop.settings, collect: { value: '{{ map.output.doubled }}' } } }
        const trigger: FlowTrigger = {
            name: 'trigger',
            displayName: 'Trigger',
            type: FlowTriggerType.EMPTY,
            valid: true,
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            settings: {},
            nextAction: loop,
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
            sampleData: { map: { doubled: 8 } },
            engineConstants: generateMockEngineConstants({ stepNames: ['trigger', 'loop', 'map'] }),
        })

        expect(context.getStepOutput('loop')?.output).toMatchObject({ item: 4, index: 1, collected: [8] })
    })
})
