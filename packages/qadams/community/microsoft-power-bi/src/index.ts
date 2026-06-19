import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import { getMicrosoftCloudFromAuth, getPowerBiBaseUrl } from './lib/common/microsoft-cloud';
import {
  createQadam,
  OAuth2PropertyValue,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createDatasetAction } from './lib/actions/create-dataset';
import { pushRowsToDatasetTableAction } from './lib/actions/push-rows-to-table';
import { microsoftPowerBiAuth } from './lib/auth';

export const microsoftPowerBi = createQadam({
  displayName: 'Microsoft Power BI',
  description: 'Create and manage Power BI datasets and push data to them',
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/microsoft-power-bi.png',
  categories: [QadamCategory.BUSINESS_INTELLIGENCE],
  auth: microsoftPowerBiAuth,
  authors: ['calladodan'],
  actions: [
    createDatasetAction,
    pushRowsToDatasetTableAction,
    createCustomApiCallAction({
      auth: microsoftPowerBiAuth,
      baseUrl: (auth) => {
        const cloud = getMicrosoftCloudFromAuth(auth as OAuth2PropertyValue);
        return getPowerBiBaseUrl(cloud) + '/datasets';
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
