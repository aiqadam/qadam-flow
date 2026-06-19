import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  createQadam,
  OAuth2PropertyValue,
  QadamAuth,
  Property,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { common } from './lib/common';
import { newInvoice } from './lib/triggers/new-invoice';

export const zohoAuth = QadamAuth.OAuth2({
  required: true,
  authUrl: 'https://accounts.zoho.{region}/oauth/v2/auth',
  tokenUrl: 'https://accounts.zoho.{region}/oauth/v2/token',
  scope: ['ZohoInvoice.invoices.READ'],
  props: {
    region: Property.StaticDropdown({
      displayName: 'Region',
      description: 'Select your account region',
      required: true,
      options: {
        options: [
          {
            label: 'US (.com)',
            value: 'com',
          },
          {
            label: 'Europe (.eu)',
            value: 'eu',
          },
          {
            label: 'India (.in)',
            value: 'in',
          },
          {
            label: 'Australia (.com.au)',
            value: 'com.au',
          },
          {
            label: 'Japan (.jp)',
            value: 'jp',
          },
        ],
      },
    }),
  },
});

export const zohoInvoice = createQadam({
  displayName: 'Zoho Invoice',
  description: 'Online invoicing software for businesses',

  auth: zohoAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/zoho-invoice.png',
  categories: [QadamCategory.ACCOUNTING],
  authors: ["kishanprmr","MoShizzle","abuaboud"],
  actions: [
    createCustomApiCallAction({
      baseUrl: (auth) =>
        common.baseUrl((auth as OAuth2PropertyValue).props!['region']),
      auth: zohoAuth,
      authMapping: async (auth) =>
        common.authHeaders((auth as OAuth2PropertyValue).access_token),
    }),
  ],
  triggers: [newInvoice],
});
