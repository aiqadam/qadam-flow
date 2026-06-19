import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam, OAuth2PropertyValue } from "@aiqadam/qadams-framework";
import { retrieveRedditPost } from './lib/actions/retrieve-reddit-post';
import { getRedditPostDetails } from './lib/actions/get-reddit-post-details';
import { createRedditPost } from './lib/actions/create-reddit-post';
import { createRedditComment } from './lib/actions/create-reddit-comment';
import { fetchPostComments} from './lib/actions/fetch-post-comments';
import { editRedditPost } from './lib/actions/edit-reddit-post';
import { editRedditComment } from './lib/actions/edit-reddit-comment';
import { deleteRedditPost } from './lib/actions/delete-reddit-post';
import { deleteRedditComment } from './lib/actions/delete-reddit-comment';
import { QadamCategory } from '@aiqadam/shared';
import { redditAuth } from './lib/auth';

const markdown = `
To obtain your Reddit API credentials:

1. Go to https://www.reddit.com/prefs/apps.
2. Click "create another app..." at the bottom.
3. Select "script" as the app type.
4. Fill in the required information:
   - name: Your app name
   - description: Brief description
   - about url: Can be left blank
   - redirect uri: as shown in Redirect URL field
5. Click "create app".
6. Note down the client ID (under the app name) and client secret.
`;

export const reddit = createQadam({
  displayName: 'Reddit',
  description: 'Interact with Reddit - fetch and submit posts.',
  logoUrl: '/assets/qadams/reddit.png',
  minimumSupportedRelease: '0.36.1',
  categories: [QadamCategory.COMMUNICATION],
  authors: ['bhaviksingla1403'],
  auth: redditAuth,
  actions: [
    retrieveRedditPost,
    getRedditPostDetails,
    createRedditPost,
    createRedditComment,
    fetchPostComments,
    editRedditPost,
    editRedditComment,
    deleteRedditPost,
    deleteRedditComment,
    createCustomApiCallAction({
      auth: redditAuth,
      baseUrl: () => {
        return 'https://oauth.reddit.com';
      },
      authMapping: async (auth) => {
        return {
          Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
          'User-Agent': 'ActivePieces/1.0.0'
        };
      },
    }),
  ],
  triggers: [],
});
