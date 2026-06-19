import { createQadam } from '@aiqadam/qadams-framework';
import { googleNewsSearch } from './lib/actions/google-news-search';
import { googleSearch } from './lib/actions/google-search';
import { googleTrendsSearch } from './lib/actions/google-trends-search';
import { youtubeSearch } from './lib/actions/youtube-search';
import { serpApiAuth } from './lib/auth';

export const serpApi = createQadam({
  displayName: 'SerpApi',
  description: 'Search Google, YouTube, News, and Trends with powerful filtering and analysis capabilities',
  auth: serpApiAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/serp-api.png',
  authors: ['AnkitSharmaOnGithub'],
  actions: [
    googleSearch,
    googleNewsSearch,
    youtubeSearch,
    googleTrendsSearch,
  ],
  triggers: [],
});
