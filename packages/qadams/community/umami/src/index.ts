import { createQadam } from '@aiqadam/qadams-framework';
import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { QadamCategory } from '@aiqadam/shared';
import { umamiAuth, UmamiAuthValue, getAuthHeaders, getBaseUrl } from './lib/auth';
import { getWebsiteStats } from './lib/actions/get-website-stats';
import { getWebsiteMetrics } from './lib/actions/get-website-metrics';
import { getActiveVisitors } from './lib/actions/get-active-visitors';
import { getPageviews } from './lib/actions/get-pageviews';
import { sendEvent } from './lib/actions/send-event';
import { listWebsites } from './lib/actions/list-websites';
import { newEvent } from './lib/triggers/new-event';
import { newSession } from './lib/triggers/new-session';

export const umami = createQadam({
  displayName: 'Umami',
  description: 'Privacy-focused, open-source web analytics.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/umami.png',
  categories: [QadamCategory.BUSINESS_INTELLIGENCE],
  auth: umamiAuth,
  authors: ['bst1n'],
  actions: [
    getWebsiteStats,
    getWebsiteMetrics,
    getActiveVisitors,
    getPageviews,
    sendEvent,
    listWebsites,
    createCustomApiCallAction({
      auth: umamiAuth,
      baseUrl: (auth) => (auth ? getBaseUrl(auth as UmamiAuthValue) : 'https://api.umami.is/v1'),
      authMapping: async (auth) => getAuthHeaders(auth as UmamiAuthValue),
    }),
  ],
  triggers: [newEvent, newSession],
});
