import { FlowStatus, FlowTriggerType, isNil, PopulatedFlow } from "@aiqadam/shared";
import { FlowsContext, ListFlowsContextParams, Property, QadamAuth } from "@aiqadam/qadams-framework";


export const callableFlowKey = (runId: string) => `callableFlow_${runId}`;

export type CallableFlowRequest = {
    data: unknown;
    callbackUrl: string;
}
export type CallableFlowResponse = {
    status: 'success' | 'error';
    data: unknown;
}

export const MOCK_CALLBACK_IN_TEST_FLOW_URL = 'MOCK';

export type CallableFlowValue = {
    externalId: string;
    exampleData: unknown;
};

// Published flows with a "Callable Flow" trigger; disabled ones are listed, marked, and refused at run time.
export function callableFlowDropdown() {
    return Property.Dropdown<CallableFlowValue>({
        auth: QadamAuth.None(),
        displayName: 'Flow',
        description: 'The flow to execute. Published flows with a "Callable Flow" trigger appear here; disabled flows are marked "(inactive)" and cannot be executed until they are enabled.',
        required: true,
        options: async (_, context) => {
            const flows = await listFlowsWithSubflowTrigger({
                flowsContext: context.flows,
            });
            return {
                options: flows.map((flow) => ({
                    value: {
                        externalId: flow.externalId ?? flow.id,
                        exampleData: flow.version.trigger.settings.input.exampleData,
                    },
                    label:
                        flow.status === FlowStatus.ENABLED
                            ? flow.version.displayName
                            : `${flow.version.displayName} (inactive)`,
                })),
            };
        },
        refreshers: [],
    });
}

export async function listFlowsWithSubflowTrigger({
    flowsContext,
    params,
}: ListParams): Promise<PopulatedFlow[]> {
    const allFlows = (await flowsContext.list(params)).data;
    const flows = allFlows.filter(
        (flow) =>
            flow.version.trigger.type === FlowTriggerType.PIECE &&
            flow.version.trigger.settings.qadamName ==
            '@aiqadam/qadam-subflows'
    );
    return flows;
}

export async function findFlowByExternalIdOrThrow({
    flowsContext,
    externalId,
}: {
    flowsContext: FlowsContext;
    externalId: string | undefined;
}): Promise<PopulatedFlow> {
    if (isNil(externalId)) {
        throw new Error(JSON.stringify({
            message: 'Please select a flow',
        }));
    }
    const externalIds = [externalId];
    const allFlows = await listFlowsWithSubflowTrigger({
        flowsContext,
        params: {
            externalIds
        }
    });
    if (allFlows.length === 0) {
        throw new Error(JSON.stringify({
            message: 'Flow not found',
            externalId,
        }));
    }
    return allFlows[0];
}

type ListParams = {
    flowsContext: FlowsContext,
    params?: ListFlowsContextParams
}