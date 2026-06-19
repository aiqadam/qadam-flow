import { createQadam } from '@aiqadam/qadams-framework';
import { braveWebSearchAction } from './lib/actions/web-search';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { braveSearchAuth } from './lib/auth';

export const braveSearch = createQadam({
  displayName: 'Brave Search',
  description: 'Privacy-preserving search engine',
  auth: braveSearchAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/brave-search.png',
  authors: ['ErisMorn', 'sanket-a11y'],
  actions: [
    braveWebSearchAction,
    createCustomApiCallAction({
      auth: braveSearchAuth,
      baseUrl: () => 'https://api.search.brave.com/res/v1',
      authMapping: async (auth) => {
        return {
          'X-Subscription-Token': auth.secret_text,
        };
      },
    }),
  ],
  triggers: [],
});
