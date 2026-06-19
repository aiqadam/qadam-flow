import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { telnyxAuth } from './lib/auth';
import { sendSmsAction } from './lib/actions/send-sms';
import { makeCallAction } from './lib/actions/make-call';
import { messageReceivedTrigger } from './lib/triggers/message-received';

export const telnyx = createQadam({
  displayName: 'Telnyx',
  description:
    'Telecom API platform for SMS messaging, voice calls, and messaging webhooks.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/telnyx.png',
  categories: [QadamCategory.COMMUNICATION, QadamCategory.DEVELOPER_TOOLS],
  auth: telnyxAuth,
  authors: ['Harmatta', 'sanket-a11y'],
  actions: [
    sendSmsAction,
    makeCallAction,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.telnyx.com/v2',
      auth: telnyxAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth.secret_text}`,
      }),
    }),
  ],
  triggers: [messageReceivedTrigger],
});
