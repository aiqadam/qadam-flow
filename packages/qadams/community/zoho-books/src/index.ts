import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  OAuth2PropertyValue,
  QadamAuth,
  Property,
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';

export const zohoBooksAuth = QadamAuth.OAuth2({
  props: {
    location: Property.StaticDropdown({
      displayName: 'Location',
      description: 'The location of your Zoho Books account',
      required: true,
      options: {
        options: [
          {
            label: 'zoho.eu (Europe)',
            value: 'zoho.eu',
          },
          {
            label: 'zoho.com (United States)',
            value: 'zoho.com',
          },
          {
            label: 'zoho.com.au (Australia)',
            value: 'zoho.com.au',
          },
          {
            label: 'zoho.jp (Japan)',
            value: 'zoho.jp',
          },
          {
            label: 'zoho.in (India)',
            value: 'zoho.in',
          },
          {
            label: 'zohocloud.ca (Canada)',
            value: 'zohocloud.ca',
          },
        ],
      },
    }),
  },
  description: 'Authentication for Zoho Books',
  scope: ['ZohoBooks.fullaccess.all'],
  authUrl: 'https://accounts.{location}/oauth/v2/auth',
  tokenUrl: 'https://accounts.{location}/oauth/v2/token',
  required: true,
});

export const zohoBooks = createQadam({
  displayName: "Zoho Books",
  description: 'Comprehensive online accounting software for small businesses.',
  logoUrl: "/assets/qadams/zoho-books.png",
  minimumSupportedRelease: '0.30.0',
  categories: [QadamCategory.ACCOUNTING],
  authors: ["ikus060"],
  auth: zohoBooksAuth,
  actions: [
    createCustomApiCallAction({
      baseUrl: (auth) =>
      {
        const data = (auth as OAuth2PropertyValue).data;
        return data && data['api_domain']? `${data['api_domain']}/books/v3` : ''
      },        
      auth: zohoBooksAuth,
      authMapping: async (auth) => ({
        Authorization: `Zoho-oauthtoken ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [],
});
    