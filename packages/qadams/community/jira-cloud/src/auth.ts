import {
  AppConnectionValueForAuthProperty,
  QadamAuth,
  Property,
} from '@aiqadam/qadams-framework';
import { sendJiraRequest } from './lib/common';
import { HttpError, HttpMethod } from '@aiqadam/qadams-common';
import { z } from 'zod';
import { propsValidation } from '@aiqadam/qadams-common';
import { AppConnectionType } from '@aiqadam/shared';

export const jiraCloudAuth = QadamAuth.CustomAuth({
  description: `
You can generate your API token from:
***https://id.atlassian.com/manage-profile/security/api-tokens***
    `,
  required: true,
  props: {
    instanceUrl: Property.ShortText({
      displayName: 'Instance URL',
      description:
        'The link of your Jira instance (e.g https://example.atlassian.net)',
      required: true,
    }),
    email: Property.ShortText({
      displayName: 'Email',
      description: 'The email you use to login to Jira',
      required: true,
    }),
    apiToken: QadamAuth.SecretText({
      displayName: 'API Token',
      description: 'Your Jira API Token',
      required: true,
    }),
  },
  validate: async ({ auth }) => {
    try {
      await propsValidation.validateZod(auth, {
        instanceUrl: z.string().url(),
        email: z.string().email(),
      });

      await sendJiraRequest({
        auth: {
          type: AppConnectionType.CUSTOM_AUTH,
          props: auth,
        },
        method: HttpMethod.GET,
        url: 'myself',
      });
      return {
        valid: true,
      };
    } catch (e) {
      const message = ((e as HttpError).response?.body as any)?.message;
      return {
        valid: false,
        error: message ?? 'Invalid credentials',
      };
    }
  },
});

export type JiraAuth = AppConnectionValueForAuthProperty<typeof jiraCloudAuth>;