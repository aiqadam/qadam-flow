import {
  createAction,
  DynamicPropsValue,
  QadamAuth,
  Property,
} from '@aiqadam/qadams-framework';
import { httpClient, HttpMethod } from '@aiqadam/qadams-common';
import { ExecutionType, FAIL_PARENT_ON_FAILURE_HEADER, FlowStatus, isNil, PARENT_RUN_ID_HEADER, PARENT_RUN_LOCALE_HEADER, spreadIfDefined } from '@aiqadam/shared';
import { callableFlowDropdown, CallableFlowRequest, CallableFlowResponse, CallableFlowValue, findFlowByExternalIdOrThrow } from '../common';

export const callFlow = createAction({
  name: 'callFlow',
  // Pauses only in Queue mode with `waitForResponse`; an inline call runs in-process.
  pauses: 'conditional',
  displayName: 'Call Flow',
  description: 'Call a flow that has "Callable Flow" trigger',
  props: {
    flow: callableFlowDropdown(),
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      required: true,
      description: 'Choose Simple for key-value or Advanced for JSON.',
      defaultValue: 'simple',
      options: {
        disabled: false,
        options: [
          {
            label: 'Simple',
            value: 'simple',
          },
          {
            label: 'Advanced',
            value: 'advanced',
          },
        ],
      },
    }),
    flowProps: Property.DynamicProperties({
      auth: QadamAuth.None(),
      description: '',
      displayName: '',
      required: true,
      refreshers: ['flow', 'mode'],
      props: async (propsValue) => {
        const castedFlowValue = propsValue['flow'] as unknown as CallableFlowValue;
        const mode = propsValue['mode'] as unknown as string;
        const fields: DynamicPropsValue = {};


        if (!isNil(castedFlowValue)) {
          if (mode === 'simple') {
            fields['payload'] = Property.Object({
              displayName: 'Payload',
              required: true,
              defaultValue: (castedFlowValue.exampleData as unknown as { sampleData: object }).sampleData,
            });
          }
          else{
            fields['payload'] = Property.Json({
              displayName: 'Payload',
              description:
                'Provide the data to be passed to the flow',
              required: true,
              defaultValue: (castedFlowValue.exampleData as unknown as { sampleData: object }).sampleData,
            });
          }
        }
        return fields;
      },
    }),
    waitForResponse: Property.Checkbox({
      displayName: 'Wait for Response',
      required: false,
      defaultValue: false,
    }),
    executionMode: Property.StaticDropdown({
      displayName: 'Execution Mode',
      required: true,
      description: 'Queue dispatches the subflow as a separate worker job (default, works for every subflow). Inline runs it synchronously in the same engine process for much lower latency — use it for chains of lightweight subflows. The subflow must not pause (Delay, Human Input/Approval, or its own Queue-mode Call Flow) when run inline.',
      defaultValue: 'queue',
      options: {
        disabled: false,
        options: [
          { label: 'Queue', value: 'queue' },
          { label: 'Inline', value: 'inline' },
        ],
      },
    }),
  },
  async run(context) {
    if (context.executionType === ExecutionType.RESUME) {
      const response = context.resumePayload.body as CallableFlowResponse;
      const shouldFailParentRun = response.status === 'error' && context.propsValue.waitForResponse
      if (shouldFailParentRun) {
        throw new Error(JSON.stringify(response.data, null, 2))
      }
      return {
        status: response.status,
        data: response.data
      }
    }
    const payload = context.propsValue.flowProps['payload'];
    const flow = await findFlowByExternalIdOrThrow({
      flowsContext: context.flows,
      externalId: context.propsValue.flow?.externalId,
    });

    if (flow.status !== FlowStatus.ENABLED) {
      throw new Error(JSON.stringify({
        message: 'The selected subflow is disabled. Enable it before calling it from a parent flow.',
        externalId: context.propsValue.flow?.externalId,
        flowName: flow.version.displayName,
      }));
    }

    if (context.propsValue.executionMode === 'inline') {
      const inlineResponse = await context.run.callFlowInline({
        flowId: flow.id,
        payload,
      });
      const shouldFailParentRun = inlineResponse.status === 'error' && context.propsValue.waitForResponse;
      if (shouldFailParentRun) {
        throw new Error(JSON.stringify(inlineResponse.data, null, 2));
      }
      return inlineResponse;
    }

    let callbackUrl: string | undefined
    if (context.propsValue.waitForResponse) {
      const waitpoint = await context.run.createWaitpoint({
        type: 'WEBHOOK',
        // Resumed exclusively by the child flow's own Return Response step
        // POSTing back into this same server instance — never by a human or
        // an external service — so its resume URL should be built from the
        // deployment's internal address, not the externally reachable one.
        internal: true,
      });
      callbackUrl = waitpoint.buildResumeUrl({
        queryParams: {},
      });
      context.run.waitForWaitpoint(waitpoint.id);
    }

    const parentRunLocale = await context.run.locale();
    const response = await httpClient.sendRequest<CallableFlowRequest>({
      method: HttpMethod.POST,
      url: `${context.server.apiUrl}v1/webhooks/${flow?.id}`,
      headers: {
        'Content-Type': 'application/json',
        [PARENT_RUN_ID_HEADER]: context.run.id,
        [FAIL_PARENT_ON_FAILURE_HEADER]: context.propsValue.waitForResponse ? 'true' : 'false',
        // The child inherits this run's resolved locale (own `localeSource`, or one already
        // inherited from further up the chain) so `$t[...]` in the child resolves the same way an
        // Inline call's direct field-pass would. Omitted entirely when nothing resolved to a
        // locale, so the consumer's own project-default fallback still applies.
        ...spreadIfDefined(PARENT_RUN_LOCALE_HEADER, parentRunLocale),
      },
      body: {
        data: payload,
        callbackUrl,
      },
    });
    return response.body;
  },
  errorHandlingOptions: {
    continueOnFailure: {
      defaultValue:false,
      hide:false,
    },
    retryOnFailure: {
      defaultValue:false,
      hide:false,
    }
  }
});
