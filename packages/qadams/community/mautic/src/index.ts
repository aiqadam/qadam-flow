import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  createQadam,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import {
  createCompany,
  createContact,
  searchCompany,
  searchContact,
  updateCompany,
  updateContact,
} from './lib/actions';
import { triggers } from './lib/triggers';
import { mauticAuth } from './lib/auth';

const markdownDescription = `
Follow these steps:

1. **Enter the Base URL:** Open your Mautic instance and copy the URL from the address bar. If your dashboard link is "https://mautic.ddev.site/s/dashboard", set your base URL as "https://mautic.ddev.site/".

2. **Enable Basic Authentication:** Log in to Mautic, go to **Settings** > **Configuration** > **API Settings**, and ensure that Basic Authentication is enabled.

`;

export const mautic = createQadam({
  displayName: 'Mautic',
  description: 'Open-source marketing automation software',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/mautic.png',
  authors: ["bibhuty-did-this","kanarelo","kishanprmr","MoShizzle","khaledmashaly","abuaboud"],
  categories: [QadamCategory.MARKETING],
  auth: mauticAuth,
  actions: [
    createContact,
    searchContact,
    updateContact,
    createCompany,
    searchCompany,
    updateCompany,
    createCustomApiCallAction({
      auth: mauticAuth,
      baseUrl: (auth) => {
        if (!auth) {
          return '';
        }
        const { base_url } = auth.props;
        return `${base_url.endsWith('/') ? base_url : base_url + '/'}api/`;
      },
      authMapping: async (auth) => {
        const { username, password } = auth.props;
        return {
          Authorization:
            'Basic ' +
            Buffer.from(`${username}:${password}`).toString('base64'),
          'Content-Type': 'application/json',
        };
      },
    }),
  ],
  triggers,
});
