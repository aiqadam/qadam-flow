import { createCustomApiCallAction } from '@aiqadam/qadams-common';
import {
  createQadam,
  OAuth2PropertyValue,
} from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { downloadFile } from './lib/actions/download-file';
import { listFiles } from './lib/actions/list-files';
import { listFolders } from './lib/actions/list-folders';
import { uploadFile } from './lib/actions/upload-file';
import { oneDriveAuth } from './lib/auth';
import { oneDriveCommon } from './lib/common/common';
import { newFile } from './lib/triggers/new-file';

export const microsoftOneDrive = createQadam({
  displayName: 'Microsoft OneDrive',
  description: 'Cloud storage by Microsoft',
  auth: oneDriveAuth,
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/oneDrive.png',
  categories: [QadamCategory.CONTENT_AND_FILES],
  authors: ['BastienMe', 'kishanprmr', 'MoShizzle', 'abuaboud', 'ikus060'],
  actions: [
    uploadFile,
    downloadFile,
    listFiles,
    listFolders,
    createCustomApiCallAction({
      baseUrl: (auth) => {
        const cloud = (auth as OAuth2PropertyValue).props?.['cloud'] as string | undefined;
        return oneDriveCommon.getBaseUrl(cloud);
      },
      auth: oneDriveAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${(auth as OAuth2PropertyValue).access_token}`,
      }),
    }),
  ],
  triggers: [newFile],
});
