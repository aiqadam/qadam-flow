import {
  OAuth2PropertyValue,
  QadamAuth,
  createQadam,
} from '@aiqadam/qadams-framework';

import { QadamCategory } from '@aiqadam/shared';
import { createCompanyUpdate } from './lib/actions/create-company-update';
import { createShareUpdate } from './lib/actions/create-share-update';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { linkedinCommon } from './lib/common';

export const linkedinAuth = QadamAuth.OAuth2({
  authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
  tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  required: true,
  scope: [
    'w_member_social',
    'w_organization_social',
    'rw_organization_admin',
    'openid',
    'email',
    'profile',
  ],
});

export const linkedin = createQadam({
  displayName: 'LinkedIn',
  description: 'Connect and network with professionals',

  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/linkedin.png',
  categories: [QadamCategory.MARKETING],
  authors: ["aasimsani","kishanprmr","MoShizzle","khaledmashaly","abuaboud", "izdrail"],
  auth: linkedinAuth,
  actions: [
    createShareUpdate,
    createCompanyUpdate,
    createCustomApiCallAction({
      auth: linkedinAuth,
      baseUrl: () => {
        return linkedinCommon.baseUrl;
      },
      authMapping: async (auth) => {
        return {
          Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
        };
      },
    }),
  ],
  triggers: [],
});
