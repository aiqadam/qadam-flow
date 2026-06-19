import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { googleContactsAddContactAction } from './lib/action/create-contact';
import { googleContactsUpdateContactAction } from './lib/action/update-contact';
import { googleContactsSearchContactsAction } from './lib/action/search-contact';
import { googleContactsCommon } from './lib/common';
import { googleContactNewOrUpdatedContact } from './lib/trigger/new-contact';
import { googleContactsAuth } from './lib/auth';

export const googleContacts = createQadam({
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/google-contacts.png',
  categories: [QadamCategory.SALES_AND_CRM],
  actions: [
    googleContactsAddContactAction,
    googleContactsUpdateContactAction,
    googleContactsSearchContactsAction,
    createCustomApiCallAction({
      baseUrl: () => googleContactsCommon.baseUrl,
      auth: googleContactsAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth).access_token}`,
      }),
    }),
  ],
  displayName: 'Google Contacts',
  description: 'Stay connected and organized',

  authors: [
    'Abdallah-Alwarawreh',
    'Salem-Alaa',
    'kishanprmr',
    'MoShizzle',
    'khaledmashaly',
    'abuaboud',
    'ikus060',
  ],
  triggers: [googleContactNewOrUpdatedContact],
  auth: googleContactsAuth,
});
