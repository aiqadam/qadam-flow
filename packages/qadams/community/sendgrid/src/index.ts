import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { sendDynamicTemplate } from './lib/actions/send-dynamic-template';
import { sendEmail } from './lib/actions/send-email';
import { getApiKey, getBaseUrl, sendgridAuth, SendgridAuthValue } from './lib/common';

export { sendgridAuth, SendgridAuthValue } from './lib/common';

export const sendgrid = createQadam({
  displayName: 'SendGrid',
  description:
    'Email delivery service for sending transactional and marketing emails',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/sendgrid.png',
  authors: ['ashrafsamhouri', 'kishanprmr', 'MoShizzle', 'khaledmashaly', 'abuaboud', 'Thijs-Attenza'],
  categories: [QadamCategory.COMMUNICATION, QadamCategory.MARKETING],
  auth: sendgridAuth,
  actions: [
    sendEmail,
    sendDynamicTemplate,
    createCustomApiCallAction({
      baseUrl: (auth) => getBaseUrl(auth as SendgridAuthValue),
      auth: sendgridAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${getApiKey(auth as SendgridAuthValue)}`,
      }),
    }),
  ],
  triggers: [],
});
