import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { createProject } from './lib/actions/create-project';
import { listProject } from './lib/actions/list-project';
import { updateProject } from './lib/actions/update-project';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { activeQadamAuth } from './lib/auth';

const markdown = `
Qadam Flow Platform API is available for platform administrators.
(https://flow.aiqadam.org/docs/admin-console/overview)

**Note**: The API Key is available in the Platform Dashboard.

`;

export const activepieces = createQadam({
  displayName: 'Qadam Flow Platform',
  description: 'Open source no-code business automation',
  auth: activeQadamAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/activepieces.png',
  authors: ['doskyft', 'abuaboud', 'AdamSelene'],
  actions: [
    createProject,
    updateProject,
    listProject,
    createCustomApiCallAction({
      baseUrl: (auth) => {
        return `${auth?.props.baseApiUrl}`;
      },
      auth: activeQadamAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth.props.apiKey}`,
      }),
    }),
  ],
  triggers: [],
});
