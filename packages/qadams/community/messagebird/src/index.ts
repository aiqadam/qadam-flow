import { createQadam } from '@aiqadam/qadams-framework';
import { sendSMSAction } from './lib/actions/send-sms.action';
import { QadamCategory } from '@aiqadam/shared';
import { listMessages } from './lib/actions/list-messages';
import { birdAuth, BirdAuthValue } from './lib/auth';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';

export const messagebird = createQadam({
  displayName: 'Bird',
  description: 'Unified CRM for Marketing, Service & Payments',
  auth: birdAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/messagebird.png',
  categories: [QadamCategory.MARKETING, QadamCategory.COMMUNICATION],
  authors: ['kishanprmr', 'geekyme','prasanna2000-max'],
  actions: [
    sendSMSAction,
    listMessages,
    createCustomApiCallAction({
      baseUrl: (auth)=> {
        return auth ? 'https://api.bird.com/workspaces/' + (auth.props as BirdAuthValue).workspaceId : '';
      },
      auth: birdAuth,
      authMapping: async (auth) => {
        return {
          Authorization: `Bearer ${(auth.props as BirdAuthValue).apiKey}`,
        };
      }
    }),
  ],
  triggers: [],
});
