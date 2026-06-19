import { HttpMethod } from '@aiqadam/qadams-common';
import { QadamAuth } from '@aiqadam/qadams-framework';
import { telnyxRequest } from './common/client';

export const telnyxAuth = QadamAuth.SecretText({
  displayName: 'API Key',
  description: 'Your Telnyx API key.',
  required: true,
  validate: async ({ auth }) => {
    try {
      await telnyxRequest({
        apiKey: auth,
        method: HttpMethod.GET,
        path: '/messaging_profiles',
      });
      return { valid: true };
    } catch {
      return {
        valid: false,
        error: 'Invalid API key or unable to reach the Telnyx API.',
      };
    }
  },
});
