import {
  createCustomApiCallAction,
  HttpMethod,
} from '@aiqadam/qadams-common';
import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { clicksendSendSmsAction } from './lib/action/send-sms';
import { clicksendSendMms } from './lib/action/send-mms';
import { clicksendCreateContactAction } from './lib/action/create-contact';
import { clicksendUpdateContactAction } from './lib/action/update-contact';
import { clicksendDeleteContactAction } from './lib/action/delete-contact';
import { clicksendCreateContactListAction } from './lib/action/create-contact-list';
import { clicksendFindContactByEmailAction } from './lib/action/search-contact-by-email';
import { clicksendFindContactByPhoneAction } from './lib/action/search-contact-by-phone';
import { clicksendFindContactListAction } from './lib/action/search-contact-lists';
import { clicksendNewIncomingSms } from './lib/trigger/new-incoming-sms';
import { callClickSendApi } from './lib/common';

export const clicksendAuth = QadamAuth.BasicAuth({
  description: `You can get your API credentials by clicking 'API Credentials' on the top right of the dashboard.`,
  required: true,
  username: {
    displayName: 'Username',
    description: 'Your ClickSend username',
  },
  password: {
    displayName: 'API Key',
    description: 'Your ClickSend API key',
  },
  validate: async ({ auth }) => {
    try {
      await callClickSendApi({
        method: HttpMethod.GET,
        path: '/account',
        username: auth.username,
        password: auth.password,
      });
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid Credentials.' };
    }
  },
});

export const clicksend = createQadam({
  displayName: 'ClickSend SMS',
  description:
    'Cloud-based messaging platform for sending SMS, MMS, voice, email, and more.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/clicksend.png',
  auth: clicksendAuth,
  categories: [QadamCategory.COMMUNICATION],
  actions: [
    clicksendSendSmsAction,
    clicksendSendMms,
    clicksendCreateContactAction,
    clicksendUpdateContactAction,
    clicksendDeleteContactAction,
    clicksendCreateContactListAction,
    clicksendFindContactByEmailAction,
    clicksendFindContactByPhoneAction,
    clicksendFindContactListAction,
    createCustomApiCallAction({
      baseUrl: () => 'https://rest.clicksend.com/v3',
      auth: clicksendAuth,
      authMapping: async (auth) => ({
        Authorization: `Basic ${Buffer.from(
          `${(auth as { username: string }).username}:${
            (auth as { password: string }).password
          }`
        ).toString('base64')}`,
      }),
    }),
  ],
  authors: ['sparkybug'],
  triggers: [clicksendNewIncomingSms],
});
