import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { digitalOceanAuth } from './lib/common/auth';
import {
  listDomains,
  createDomain,
  getDomain,
  deleteDomain,
  listDroplets,
  getDroplet,
  createDroplet,
  deleteDroplet,
  listDatabaseClusters,
  listDatabaseEvents,
} from './lib/actions';

export const digitalOcean = createQadam({
  displayName: 'DigitalOcean',
  auth: digitalOceanAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/digital-ocean.png',
  description: 'Cloud infrastructure provider for developers.',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ['onyedikachi-david'],
  actions: [
    listDomains,
    createDomain,
    getDomain,
    deleteDomain,
    listDroplets,
    getDroplet,
    createDroplet,
    deleteDroplet,
    listDatabaseClusters,
    listDatabaseEvents,
    createCustomApiCallAction({
      baseUrl: () => 'https://api.digitalocean.com/v2',
      auth: digitalOceanAuth,
      authMapping: async (auth) => {
        const token = typeof auth === 'string' ? auth : (auth as { access_token: string }).access_token;
        return {
          Authorization: `Bearer ${token}`,
        };
      },
    }),
  ],
  triggers: [],
});
