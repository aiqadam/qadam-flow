import { createAction, Property } from '@aiqadam/qadams-framework';
import {
  AuthenticationType,
  httpClient,
  HttpMethod,
} from '@aiqadam/qadams-common';
import { activeQadamAuth } from '../auth';

export const createProject = createAction({
  name: 'create_project',
  auth: activeQadamAuth,
  displayName: 'Create Project',
  description: 'Create a new project',
  audience: 'both',
  aiMetadata: {
    description:
      'Create a new project on a Qadam Flow platform (requires a platform API key). Use when provisioning a fresh project workspace; the only input is its display name. Not idempotent — each call creates a separate project even with the same name.',
    idempotent: false,
  },
  props: {
    display_name: Property.ShortText({
      displayName: 'Display Name',
      description: undefined,
      required: true,
    }),
  },
  async run({ propsValue, auth }) {
    const response = await httpClient.sendRequest<string[]>({
      method: HttpMethod.POST,
      url: `${auth.props.baseApiUrl}/projects`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: auth.props.apiKey,
      },
      body: {
        displayName: propsValue['display_name'],
      },
    });

    return response.body;
  },
});
