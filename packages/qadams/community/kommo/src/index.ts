import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { leadStatusChangedTrigger, newContactAddedTrigger, newLeadCreatedTrigger, newTaskCreatedTrigger } from "./lib/triggers";
import { findLeadAction, updateContactAction, createLeadAction, createContactAction, findContactAction, findCompanyAction, updateLeadAction } from "./lib/actions";
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { kommoAuth } from './lib/auth';

const markdownDescription = `
Please follow [Generate Long Live Token](https://developers.kommo.com/docs/long-lived-token) guide for generating token.

Your Kommo account subdomain (e.g., "mycompany" if your URL is mycompany.kommo.com).

`;

export const kommo = createQadam({
  displayName: 'Kommo',
  auth: kommoAuth,
  logoUrl: '/assets/qadams/kommo.png',
  categories: [QadamCategory.COMMUNICATION, QadamCategory.SALES_AND_CRM],
  authors: ['krushnarout', 'kishanprmr'],
  actions: [findLeadAction, updateContactAction, createLeadAction, updateLeadAction, createContactAction, findContactAction, findCompanyAction,
    createCustomApiCallAction({
      auth: kommoAuth,
      baseUrl: (auth) => {
        if (!auth) {
          return '';
        }
        const authValue = auth.props;
        return `https://${authValue.subdomain}.kommo.com/api/v4`
      },
      authMapping: async (auth) => {
        const authValue = auth.props;
        return {
          Authorization: `Bearer ${authValue.apiToken}`
        }

      }
    })
  ],
  triggers: [leadStatusChangedTrigger, newContactAddedTrigger, newLeadCreatedTrigger, newTaskCreatedTrigger],
});
