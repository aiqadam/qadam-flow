import { createAction } from '@aiqadam/qadams-framework';
import {
  AuthenticationType,
  httpClient,
  HttpMethod,
} from '@aiqadam/qadams-common';
import { activeQadamAuth } from '../auth';

export const listProject = createAction({
  name: 'list_project',
  auth: activeQadamAuth,
  displayName: 'List Projects',
  description: 'List all projects',
  audience: 'both',
  aiMetadata: {
    description:
      'List all projects accessible to the authenticated Qadam Flow platform API key. Use to discover existing projects or resolve a project id before updating one. Takes no input; read-only and idempotent.',
    idempotent: true,
  },
  props: {},
  async run({ auth }) {
    const response = await httpClient.sendRequest<string[]>({
      method: HttpMethod.GET,
      url: `${auth.props.baseApiUrl}/projects`,
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token: auth.props.apiKey,
      },
    });

    return response.body;
  },
});
