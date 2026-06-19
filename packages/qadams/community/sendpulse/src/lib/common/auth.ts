import { QadamAuth } from '@aiqadam/qadams-framework';
import { sendpulseApiCall } from './client';
import { HttpMethod } from '@aiqadam/qadams-common';

export const sendpulseAuth = QadamAuth.CustomAuth({
  description: 'Enter your SendPulse client credentials',
  props: {
    clientId: QadamAuth.SecretText({
      displayName: 'Client ID',
      required: true,
    }),
    clientSecret: QadamAuth.SecretText({
      displayName: 'Client Secret',
      required: true,
    }),
  },
  validate: async ({ auth }) => {
    try {
      await sendpulseApiCall({
        method: HttpMethod.GET,
        resourceUri: '/addressbooks',
        auth,
      });
      return { valid: true };
    } catch {
      return {
        valid: false,
        error: 'Invalid Client ID or Client Secret',
      };
    }
  },
  required: true,
});
