import { createQadam } from '@aiqadam/qadams-framework';
import { sendMessage } from './lib/actions/send-message';
import { newMessage } from './lib/triggers/new-message';
import { chatwootAuth } from './lib/auth';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { getChatwootAuth } from './lib/common/types';
import { CHATWOOT_AUTH_HEADER } from './lib/common/constants';

export const chatwoot = createQadam({
  displayName: 'Chatwoot',
  description: 'Receive and reply to customer messages with Chatwoot',
  auth: chatwootAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl:
    '/assets/qadams/chatwoot.png',
  authors: ['AhmadTash'],
  actions: [sendMessage,
    createCustomApiCallAction({
      auth:chatwootAuth,
      baseUrl: (auth) => {
        const authValue = getChatwootAuth(auth!);
        return authValue.baseUrl;
      },
      authMapping: async (auth) => {
        const authValue = getChatwootAuth(auth!);
        return {
          [CHATWOOT_AUTH_HEADER]: authValue.apiAccessToken,
        };
      },
    })
  ],
  triggers: [newMessage],
});
