import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { AppConnectionType, QadamCategory } from '@aiqadam/shared';

import { createContactAction } from './lib/actions/create-contact';
import { createNewsletterAction } from './lib/actions/create-newsletter';
import { createOrUpdateContactAction } from './lib/actions/create-or-update-contact';
import { findCampaignListAction } from './lib/actions/find-campaign-list';
import { findContactAction } from './lib/actions/find-contact';
import { getresponseAuth } from './lib/common/auth';

export const getresponse = createQadam({
  displayName: 'GetResponse',
  description:
    'Email marketing and automation platform for contacts, campaigns, and newsletters.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/getresponse.png',
  categories: [QadamCategory.MARKETING],
  authors: ['veri5ied'],
  auth: getresponseAuth,
  actions: [
    createContactAction,
    createOrUpdateContactAction,
    findContactAction,
    createNewsletterAction,
    findCampaignListAction,
    createCustomApiCallAction({
      auth: getresponseAuth,
      baseUrl: () => 'https://api.getresponse.com/v3',
      authMapping: async (auth) => {
        if (auth.type === AppConnectionType.OAUTH2) {
          return { Authorization: `Bearer ${auth.access_token}` };
        }
        return { 'X-Auth-Token': `api-key ${auth.props.apiKey}` };
      },
    }),
  ],
  triggers: [],
});

export { getresponseAuth };
