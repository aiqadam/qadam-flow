import { QadamAuth, createQadam } from '@aiqadam/qadams-framework';
import { rssNewItemTrigger } from './lib/triggers/new-item-trigger';
import { rssNewItemListTrigger } from './lib/triggers/new-item-list-triggers';

export const rssFeed = createQadam({
  displayName: 'RSS Feed',
  description: 'Stay updated with RSS feeds',
  authors: ["Abdallah-Alwarawreh","kishanprmr","khaledmashaly","abuaboud", "Kevinyu-alan"],
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/rss.png',
  categories: [],
  auth: QadamAuth.None(),
  actions: [],
  triggers: [
    rssNewItemTrigger,
    rssNewItemListTrigger
  ],
});
