import { DynamicPropsValue, QadamAuth, Property, StoreScope, createAction } from '@aiqadam/qadams-framework';
import { callableFlowKey, CallableFlowResponse, MOCK_CALLBACK_IN_TEST_FLOW_URL } from '../common';
import { httpClient, HttpMethod } from '@aiqadam/qadams-common';
import { isNil } from '@aiqadam/shared';

export const response = createAction({
  name: 'returnResponse',
  displayName: 'Return Response',
  description: 'Return response to the original flow',
  props: {
    mode: Property.StaticDropdown({
      displayName: 'Mode',
      description: 'Choose Simple for key-value or Advanced for JSON.',
      required: true,
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
    response: Property.DynamicProperties({
      auth: QadamAuth.None(),
      displayName: 'Response',
      required: true,
      refreshers: ['mode'],
      props: async (propsValue) => {
        const mode = propsValue['mode'] as unknown as string;
        const fields: DynamicPropsValue = {};
        if (mode === 'simple') {
          fields['response'] = Property.Object({
            displayName: 'Response',
            required: true,
          });
        } else {
          fields['response'] = Property.Json({
            displayName: 'Response',
            required: true,
          });
        }
        return fields;
      },
    }),
  },
  async test(context) {
    return context.propsValue.response['response'];
  },
  async run(context) {
    const response = context.propsValue.response['response'];
    const callbackUrl = await context.store.get<string>(callableFlowKey(context.run.id), StoreScope.FLOW);
    const isNotTestFlow = callbackUrl !== MOCK_CALLBACK_IN_TEST_FLOW_URL;
    if (isNotTestFlow && !isNil(callbackUrl)) {
      // Queue execution mode: the parent is paused on a waitpoint, reachable only via
      // this callback POST.
      await httpClient.sendRequest<CallableFlowResponse>({
        method: HttpMethod.POST,
        url: callbackUrl,
        body: {
          status: 'success',
          data: response
        },
        retries: 10,
      });
    }
    else if (isNil(callbackUrl)) {
      // No callback was stored: either an inline `callFlow` call (synchronous,
      // in-process — nothing to POST to) or the flow was hit directly, e.g. via
      // `/v1/webhooks/:flowId/sync`. Either way, stop the flow here and hand back the
      // response synchronously, so whoever is waiting on this run gets the real value
      // instead of the default empty response.
      context.run.stop({
        response: {
          status: 200,
          body: { status: 'success', data: response } as CallableFlowResponse,
        },
      });
    }
    return response;
  },
});