import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  OAuth2PropertyValue,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { newContact } from './lib/triggers/new-contact';
import { readFile } from './lib/actions/read-file';
import { zohoCrmAuth } from './lib/auth';

export const zohoCrm = createQadam({
  displayName: 'Zoho CRM',
  description: 'Customer relationship management software',

  logoUrl: '/assets/qadams/zoho-crm.png',
  minimumSupportedRelease: '0.30.0',
  categories: [QadamCategory.SALES_AND_CRM],
  authors: ["kishanprmr","MoShizzle","khaledmashaly","abuaboud","ikus060"],
  auth: zohoCrmAuth,
  actions: [
    readFile,
    createCustomApiCallAction({
      baseUrl: (auth) =>
        {
          const data = (auth as OAuth2PropertyValue).data;
          return data && data['api_domain']? `${data['api_domain']}/crm/v3` : ''
        },    
      
      auth: zohoCrmAuth,
      authMapping: async (auth) => ({
        Authorization: `Zoho-oauthtoken ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [newContact],
});
