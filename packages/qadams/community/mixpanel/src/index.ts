import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { trackEvent } from './lib/actions/track-event';
import { mixpanelAuth } from './lib/auth';

export const mixpanel = createQadam({
  displayName: 'Mixpanel',
  description: 'Simple and powerful product analytics that helps everyone make better decisions',
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/mixpanel.png',
  authors: ["yann120","kishanprmr","MoShizzle","abuaboud"],
  auth: mixpanelAuth,
  categories: [QadamCategory.BUSINESS_INTELLIGENCE],
  actions: [
    trackEvent,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.mixpanel.com',
      auth: mixpanelAuth,
      authMapping: async (auth) => ({
        Authorization: `Basic ${Buffer.from(auth.secret_text).toString(
          'base64'
        )}`,
      }),
    }),
  ],
  triggers: [],
});
