import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import {
  createCustomApiCallAction,
  httpClient,
  HttpMethod,
} from '@aiqadam/qadams-common';

import { BASE_URL } from './lib/common';
import { createCustomer } from './lib/actions/create-customer';
import { createProject } from './lib/actions/create-project';
import { startTimer } from './lib/actions/start-timer';
import { createRegistration } from './lib/actions/create-registration';
import { stopTimer } from './lib/actions/stop-timer';
import { newCustomer } from './lib/triggers/new-customer';
import { newProject } from './lib/triggers/new-project';
import { newUser } from './lib/triggers/new-user';
import { newRegistration } from './lib/triggers/new-registration';

export const timeOpsAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  description: 'Enter your TimeOps API key. You can find it in your TimeOps account settings.',
  required: true,
  validate: async ({ auth }) => {
    try {
      await httpClient.sendRequest({
        method: HttpMethod.GET,
        url: `${BASE_URL}/customers`,
        headers: {
          'x-api-key': auth,
        },
      });

      return {
        valid: true,
      };
    } catch {
      return {
        valid: false,
        error: 'Invalid API key.',
      };
    }
  },
});

export const timeOps = createQadam({
  displayName: 'TimeOps',
  description: 'Time tracking and project management for teams and freelancers.',
  auth: timeOpsAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/time-ops.png',
  authors: ['onyedikachi-david'],
  categories: [QadamCategory.PRODUCTIVITY],
  actions: [
    createCustomer,
    createProject,
    startTimer,
    stopTimer,
    createRegistration,
    createCustomApiCallAction({
      auth: timeOpsAuth,
      baseUrl: () => BASE_URL,
      authMapping: async (auth) => ({
        'x-api-key': auth.secret_text,
      }),
    }),
  ],
  triggers: [newCustomer, newProject, newUser, newRegistration],
});