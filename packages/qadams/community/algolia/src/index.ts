import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';

import { browseRecordsAction } from './lib/actions/browse-records';
import { deleteRecordsAction } from './lib/actions/delete-records';
import { saveRecordsAction } from './lib/actions/save-records';
import { algoliaAuth } from './lib/common/auth';

export const algolia = createQadam({
  displayName: 'Algolia',
  description:
    'Manage your Algolia search indices — add, browse, and delete records.',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/algolia.png',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ['veri5ied'],
  auth: algoliaAuth,
  actions: [
    saveRecordsAction,
    browseRecordsAction,
    deleteRecordsAction,
    createCustomApiCallAction({
      auth: algoliaAuth,
      baseUrl: (auth) => {
        if (!auth) {
          return '';
        }

        return `https://${auth.props.applicationId}.algolia.net/1`;
      },
      authMapping: async (auth) => ({
        'x-algolia-application-id': auth.props.applicationId,
        'x-algolia-api-key': auth.props.apiKey,
      }),
    }),
  ],
  triggers: [],
});
